"""Free-use limits for visitors who are not logged in.

A guest gets `GUEST_MAX_FILES` attached files and `GUEST_MAX_TOKENS` tokens of chat text (what they type plus
what the assistant answers) in total, across all their chats. When either is used up they can't send any more
until they log in. Usage is kept per browser session id and saved to a small JSON file so a server restart
doesn't hand out a fresh allowance.

The session id is chosen by the browser, so this is a friendly limit, not a hard one: clearing site data gives a
new allowance. Per-account limits would need the login to be required.
"""

import json
import os
import threading
import time
from typing import Any

from core.kb import config
from core.kb.chunking import count_tokens

_lock = threading.Lock()
_usage: dict[str, dict[str, Any]] | None = None
KEEP_SECONDS = 60 * 86400  # forget guests that haven't been seen for 60 days


def _load() -> dict[str, dict[str, Any]]:
    global _usage
    if _usage is None:
        try:
            with open(config.GUEST_USAGE_PATH, encoding="utf-8") as f:
                _usage = json.load(f)
        except (OSError, ValueError):
            _usage = {}
    return _usage


def _save(data: dict[str, dict[str, Any]]) -> None:
    cutoff = time.time() - KEEP_SECONDS
    for key in [k for k, v in data.items() if v.get("seen", 0) < cutoff]:
        del data[key]
    os.makedirs(os.path.dirname(config.GUEST_USAGE_PATH) or ".", exist_ok=True)
    tmp = f"{config.GUEST_USAGE_PATH}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, config.GUEST_USAGE_PATH)  # atomic: a crash never leaves a half-written file


def status(session_id: str) -> dict[str, Any]:
    """What this guest has used so far, and whether they are out of allowance."""
    with _lock:
        used = _load().get(session_id, {})
    files, tokens = int(used.get("files", 0)), int(used.get("tokens", 0))
    return {
        "files_used": files,
        "files_limit": config.GUEST_MAX_FILES,
        "tokens_used": tokens,
        "tokens_limit": config.GUEST_MAX_TOKENS,
        "blocked": files >= config.GUEST_MAX_FILES or tokens >= config.GUEST_MAX_TOKENS,
    }


def check(session_id: str, new_files: int) -> str | None:
    """None when the guest may send this message, otherwise the message to show them."""
    s = status(session_id)
    if s["blocked"] or s["files_used"] + new_files > s["files_limit"]:
        return config.GUEST_LIMIT_MESSAGE
    return None


def chat_tokens(question: str, answer: str) -> int:
    return count_tokens(question or "") + count_tokens(answer or "")


def record(session_id: str, files: int, tokens: int) -> None:
    """Add a finished turn to the guest's usage."""
    if files <= 0 and tokens <= 0:
        return
    with _lock:
        data = _load()
        entry = data.setdefault(session_id, {"files": 0, "tokens": 0})
        entry["files"] = int(entry.get("files", 0)) + max(0, files)
        entry["tokens"] = int(entry.get("tokens", 0)) + max(0, tokens)
        entry["seen"] = time.time()
        _save(data)
