"""Per-session conversation memory.

`ConversationStore` is the seam for your database later: implement the same five methods
on top of Postgres / Mongo / etc. and swap the `store` instance at the bottom. The default
implementation keeps one JSON file per conversation under data/chats/<session_id>/.

A conversation looks like:
    {id, session_id, title, created_at, updated_at,
     summary,            # running summary of the older turns
     summarized_upto,    # messages[:summarized_upto] are folded into `summary`
     messages: [{id, role, content, sources, created_at, stopped,
                 attachments?: [{id, name, kind, mime, size}]}]}   # files live in <session>/<conversation id>/
"""

import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Protocol

from core.kb import config
from core.kb.chunking import count_tokens

_SESSION_RE = re.compile(r"^[0-9a-f-]{32,36}$")
_CONV_RE = re.compile(r"^[0-9a-f]{12}$")


def valid_session_id(value: str | None) -> bool:
    return bool(value and _SESSION_RE.match(value))


def valid_conversation_id(value: str | None) -> bool:
    return bool(value and _CONV_RE.match(value))


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_conversation(session_id: str, title: str) -> dict[str, Any]:
    """A fresh conversation, not yet persisted (it's saved with its first answer)."""
    return {
        "id": uuid.uuid4().hex[:12],
        "session_id": session_id,
        "title": title,
        "created_at": now(),
        "updated_at": now(),
        "summary": "",
        "summarized_upto": 0,
        "messages": [],
    }


class ConversationStore(Protocol):
    def create(self, session_id: str, title: str) -> dict[str, Any]: ...
    def get(self, session_id: str, conversation_id: str) -> dict[str, Any] | None: ...
    def save(self, conversation: dict[str, Any]) -> None: ...
    def list(self, session_id: str) -> list[dict[str, Any]]: ...
    def delete(self, session_id: str, conversation_id: str) -> bool: ...


class FileConversationStore:
    def __init__(self, root: str):
        self.root = root

    def _dir(self, session_id: str) -> str:
        return os.path.join(self.root, session_id)

    def _path(self, session_id: str, conversation_id: str) -> str:
        return os.path.join(self._dir(session_id), f"{conversation_id}.json")

    def create(self, session_id: str, title: str) -> dict[str, Any]:
        conversation = new_conversation(session_id, title)
        self.save(conversation)
        return conversation

    def get(self, session_id: str, conversation_id: str) -> dict[str, Any] | None:
        if not (valid_session_id(session_id) and valid_conversation_id(conversation_id)):
            return None
        path = self._path(session_id, conversation_id)
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def save(self, conversation: dict[str, Any]) -> None:
        conversation["updated_at"] = now()
        os.makedirs(self._dir(conversation["session_id"]), exist_ok=True)
        path = self._path(conversation["session_id"], conversation["id"])
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(conversation, f, ensure_ascii=False)
        os.replace(tmp, path)  # atomic: a crash never leaves a half-written conversation

    def list(self, session_id: str) -> list[dict[str, Any]]:
        if not valid_session_id(session_id) or not os.path.isdir(self._dir(session_id)):
            return []
        items = []
        for name in os.listdir(self._dir(session_id)):
            if name.endswith(".json"):
                conv = self.get(session_id, name[:-5])
                if conv:
                    items.append({k: conv[k] for k in ("id", "title", "created_at", "updated_at")})
        return sorted(items, key=lambda c: c["updated_at"], reverse=True)

    def delete(self, session_id: str, conversation_id: str) -> bool:
        if not (valid_session_id(session_id) and valid_conversation_id(conversation_id)):
            return False
        path = self._path(session_id, conversation_id)
        shutil.rmtree(os.path.join(self._dir(session_id), conversation_id), ignore_errors=True)  # attached files
        if os.path.exists(path):
            os.remove(path)
            return True
        return False


store: ConversationStore = FileConversationStore(config.CHATS_DIR)

# One lock per conversation: background summarising must not interleave with a new turn's save
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def lock_for(conversation_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(conversation_id, threading.Lock())


# ---- history windowing --------------------------------------------------------

def _tokens(message: dict[str, Any]) -> int:
    return count_tokens(message["content"]) + 4


def window_start(messages: list[dict[str, Any]]) -> int:
    """Index of the first message kept verbatim: at most the last N turns (2 messages each)
    and within the history token budget. Everything before it is "older" history."""
    keep = 0
    used = 0
    limit = config.HISTORY_TURNS * 2
    for message in reversed(messages):
        cost = _tokens(message)
        if keep >= limit or used + cost > config.HISTORY_TOKEN_BUDGET:
            break
        keep += 1
        used += cost
    # never start the window on an assistant reply without its question
    start = len(messages) - keep
    if start < len(messages) and messages[start]["role"] == "assistant":
        start += 1
    return start


def recent_messages(conversation: dict[str, Any]) -> list[dict[str, Any]]:
    """The stored messages inside the prompt window (with their attachments)."""
    messages = conversation["messages"]
    start = max(window_start(messages), conversation.get("summarized_upto", 0))
    return messages[start:]


def recent_history(conversation: dict[str, Any]) -> list[dict[str, str]]:
    """The messages to put in the prompt, as {role, content}."""
    return [{"role": m["role"], "content": m["content"]} for m in recent_messages(conversation)]


def compress(session_id: str, conversation_id: str, summarize) -> None:
    """Fold messages that fell out of the window into the running summary.

    `summarize(previous_summary, messages) -> str` is injected (an LLM call). Runs in a
    background thread after the answer has been streamed, so it never adds latency.
    """
    with lock_for(conversation_id):
        conversation = store.get(session_id, conversation_id)
        if not conversation:
            return
        messages = conversation["messages"]
        done = conversation.get("summarized_upto", 0)
        target = window_start(messages)
        if target <= done:
            return
        try:
            summary = summarize(conversation.get("summary", ""), messages[done:target])
        except Exception:
            return  # keep the old summary; we'll try again after the next turn
        conversation["summary"] = summary
        conversation["summarized_upto"] = target
        store.save(conversation)
