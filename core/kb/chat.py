"""The chat turn: memory -> rewrite -> retrieve -> prompt -> stream -> sources -> save -> log.

`stream_chat` is an async generator of Server-Sent Events:
    meta     {conversation_id, title}
    token    {t}                      (many)
    sources  {sources: [...]}         (after the last token)
    done     {latency_ms, ttft_ms, usage}
    error    {message}
"""

import asyncio
import json
import logging
import os
import re
import threading
import time
import uuid
from typing import Any, AsyncIterator

import openai

from core.kb import config, memory
from core.kb.clients import async_client
from core.kb.identity import IDENTITY_REPLY, is_identity_question
from core.kb.retrieval import Usage, retrieve, rewrite_query, summarize_history

# ---- request log (JSON lines: prompt, retrieved chunks, answer, latency, tokens) ----------

_log_lock = threading.Lock()
_logger = logging.getLogger("kb.chat")


def log_request(record: dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(config.REQUEST_LOG) or ".", exist_ok=True)
        with _log_lock, open(config.REQUEST_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        _logger.exception("could not write the request log")


# ---- helpers ------------------------------------------------------------------------------

def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _pages(meta: dict[str, Any]) -> tuple[int, int]:
    page = int(meta.get("page", 0) or 0)
    return page, max(page, int(meta.get("page_end", page) or page))


def citation_label(meta: dict[str, Any]) -> str:
    """[source: file, page 3] - or [source: file, pages 3-4] when the passage crosses a page break."""
    page, end = _pages(meta)
    name = meta.get("source", "unknown")
    if page <= 0:
        return f"[source: {name}]"
    return f"[source: {name}, page {page}]" if end == page else f"[source: {name}, pages {page}-{end}]"


def source_payload(hit: dict[str, Any]) -> dict[str, Any]:
    meta = hit["metadata"]
    page, end = _pages(meta)
    return {
        "source": meta.get("source"),
        "filename": meta.get("filename", meta.get("source")),
        "page": page,
        "page_end": end,
        "chunk_id": meta.get("chunk_id"),
        "similarity": round(hit["similarity"], 3),
        "text": hit["text"][:400],
    }


def build_messages(
    question: str, hits: list[dict[str, Any]], history: list[dict[str, str]], summary: str
) -> list[dict[str, str]]:
    """system instruction + retrieved context + (summary) + history + user question"""
    if hits:
        blocks = [f"{citation_label(h['metadata'])}\n{h['text']}" for h in hits]
        context = "Context from the knowledge base:\n\n" + "\n\n---\n\n".join(blocks)
    else:
        context = "Context from the knowledge base:\n\n(No relevant passages were found for this question.)"

    messages: list[dict[str, str]] = [
        {"role": "system", "content": config.SYSTEM_PROMPT},
        {"role": "system", "content": context},
    ]
    if summary:
        messages.append({"role": "system", "content": f"Summary of the earlier conversation: {summary}"})
    messages.extend(history)
    messages.append({"role": "user", "content": question})
    return messages


def friendly_error(exc: Exception) -> str:
    if isinstance(exc, openai.AuthenticationError):
        return "The OpenAI API key was rejected. Check OPENAI_API_KEY in your .env file."
    if isinstance(exc, openai.RateLimitError):
        return "OpenAI is rate limiting this key (or the quota is used up). Please try again in a moment."
    if isinstance(exc, (openai.APIConnectionError, openai.APITimeoutError)):
        return "Couldn't reach OpenAI. Check your internet connection and try again."
    if isinstance(exc, openai.BadRequestError):
        return "OpenAI rejected the request. Try a shorter message."
    if isinstance(exc, openai.APIStatusError):
        return f"OpenAI returned an error ({exc.status_code}). Please try again."
    if isinstance(exc, RuntimeError):
        return str(exc)
    return "Something went wrong while generating the answer."


def _save_turn(conv: dict[str, Any], question: str, answer: str, sources: list[dict], stopped: bool) -> None:
    """Append the turn to memory (re-reading under the lock so a background summary isn't lost)."""
    with memory.lock_for(conv["id"]):
        current = memory.store.get(conv["session_id"], conv["id"]) or conv
        stamp = memory.now()
        current["messages"].append(
            {"id": uuid.uuid4().hex[:12], "role": "user", "content": question, "sources": [], "created_at": stamp}
        )
        current["messages"].append(
            {"id": uuid.uuid4().hex[:12], "role": "assistant", "content": answer, "sources": sources,
             "created_at": memory.now(), "stopped": stopped}
        )
        memory.store.save(current)
    threading.Thread(
        target=memory.compress, args=(conv["session_id"], conv["id"], summarize_history), daemon=True
    ).start()


# ---- the turn ------------------------------------------------------------------------------

async def stream_chat(conv: dict[str, Any], question: str) -> AsyncIterator[str]:
    started = time.perf_counter()
    usage = Usage()
    parts: list[str] = []
    sources: list[dict[str, Any]] = []
    standalone = question
    first_token_ms: int | None = None
    status = "error"
    error_message = ""
    saved = False

    try:
        yield sse("meta", {"conversation_id": conv["id"], "title": conv["title"]})

        if is_identity_question(question):
            # "What is your name?" -> the fixed introduction, streamed word by word like any other answer
            for piece in re.findall(r"\S+\s*", IDENTITY_REPLY):
                if first_token_ms is None:
                    first_token_ms = int((time.perf_counter() - started) * 1000)
                parts.append(piece)
                yield sse("token", {"t": piece})
                await asyncio.sleep(0.02)
        else:
            history = memory.recent_history(conv)
            summary = conv.get("summary", "")
            standalone = await rewrite_query(question, history, summary, usage)
            hits = await retrieve(standalone, usage)
            sources = [source_payload(h) for h in hits]
            messages = build_messages(question, hits, history, summary)

            stream = await async_client().chat.completions.create(
                model=config.CHAT_MODEL,
                messages=messages,
                temperature=0.2,
                stream=True,
                stream_options={"include_usage": True},
            )
            async for event in stream:
                if event.usage:
                    usage.add_chat(event.usage)
                if event.choices and event.choices[0].delta.content:
                    piece = event.choices[0].delta.content
                    if first_token_ms is None:
                        first_token_ms = int((time.perf_counter() - started) * 1000)
                    parts.append(piece)
                    yield sse("token", {"t": piece})

        answer = "".join(parts)
        yield sse("sources", {"sources": sources})
        await asyncio.to_thread(_save_turn, conv, question, answer, sources, False)
        saved = True
        status = "ok"
        yield sse("done", {
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "ttft_ms": first_token_ms,
            "usage": usage.as_dict(),
        })
    except (asyncio.CancelledError, GeneratorExit):
        # The client pressed "stop" (or went away): keep what was generated so far.
        status = "stopped"
        raise
    except Exception as exc:
        error_message = f"{type(exc).__name__}: {exc}"
        _logger.exception("chat request failed")
        yield sse("error", {"message": friendly_error(exc)})
    finally:
        answer = "".join(parts)
        if status == "stopped" and answer and not saved:
            try:  # synchronous on purpose: awaiting is not allowed while the generator is being closed
                _save_turn(conv, question, answer, sources, True)
            except Exception:
                _logger.exception("could not save the partial answer")
        log_request({
            "ts": memory.now(),
            "session_id": conv["session_id"],
            "conversation_id": conv["id"],
            "status": status,
            "prompt": question,
            "standalone_query": standalone,
            "retrieved": [
                {"source": s["source"], "page": s["page"], "chunk_id": s["chunk_id"], "similarity": s["similarity"]}
                for s in sources
            ],
            "answer": answer,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "ttft_ms": first_token_ms,
            "usage": usage.as_dict(),
            "error": error_message or None,
        })
