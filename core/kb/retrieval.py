"""Query side: rewrite follow-ups, embed, retrieve top-k, threshold, optional LLM rerank."""

import asyncio
import json
import logging
from typing import Any

from core.kb import config, store
from core.kb.clients import async_client, sync_client

_logger = logging.getLogger("kb.retrieval")


class Usage:
    """Token usage accumulated over every OpenAI call made for one request."""

    def __init__(self) -> None:
        self.prompt = 0
        self.completion = 0
        self.embedding = 0

    def add_chat(self, usage: Any) -> None:
        if usage:
            self.prompt += getattr(usage, "prompt_tokens", 0) or 0
            self.completion += getattr(usage, "completion_tokens", 0) or 0

    def add_embedding(self, usage: Any) -> None:
        if usage:
            self.embedding += getattr(usage, "total_tokens", 0) or 0

    def as_dict(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt,
            "completion_tokens": self.completion,
            "embedding_tokens": self.embedding,
            "total_tokens": self.prompt + self.completion + self.embedding,
        }


def _transcript(history: list[dict[str, str]], limit: int = 800) -> str:
    return "\n".join(f"{m['role'].capitalize()}: {m['content'][:limit]}" for m in history)


async def rewrite_query(question: str, history: list[dict[str, str]], summary: str, usage: Usage) -> str:
    """Turn a follow-up ("what about its price?") into a standalone search query."""
    if not history and not summary:
        return question
    prompt = (
        "Rewrite the user's latest message as a single standalone search query that can be understood "
        "without the conversation. Resolve pronouns and references. Keep the original language. "
        "If it is already standalone (or just small talk), return it unchanged. "
        "Output only the query, nothing else.\n\n"
        + (f"Earlier conversation summary: {summary}\n\n" if summary else "")
        + f"Recent conversation:\n{_transcript(history[-6:])}\n\n"
        + f"Latest message: {question}"
    )
    try:
        response = await async_client().chat.completions.create(
            model=config.HELPER_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=120,
        )
        usage.add_chat(response.usage)
        rewritten = (response.choices[0].message.content or "").strip().strip('"')
        return rewritten or question
    except Exception:
        _logger.warning("query rewrite failed; using the original question", exc_info=True)
        return question  # retrieval with the raw question is still better than failing


async def embed_query(text: str, usage: Usage) -> list[float]:
    response = await async_client().embeddings.create(model=config.EMBED_MODEL, input=[text])
    usage.add_embedding(response.usage)
    return response.data[0].embedding


async def _rerank(query: str, candidates: list[dict[str, Any]], usage: Usage) -> list[dict[str, Any]]:
    listing = "\n\n".join(f"[{i}] {c['text'][:600]}" for i, c in enumerate(candidates))
    prompt = (
        f"Query: {query}\n\nPassages:\n{listing}\n\n"
        "Order the passage numbers from most to least useful for answering the query. "
        'Reply with JSON only: {"order": [numbers]}'
    )
    try:
        response = await async_client().chat.completions.create(
            model=config.HELPER_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            response_format={"type": "json_object"},
        )
        usage.add_chat(response.usage)
        order = json.loads(response.choices[0].message.content or "{}").get("order", [])
        seen: list[int] = []
        for n in order:
            if isinstance(n, int) and 0 <= n < len(candidates) and n not in seen:
                seen.append(n)
        seen += [i for i in range(len(candidates)) if i not in seen]  # anything the model skipped goes last
        return [candidates[i] for i in seen]
    except Exception:
        _logger.warning("rerank failed; keeping vector-similarity order", exc_info=True)
        return candidates  # keep the vector-similarity order


async def retrieve(query: str, usage: Usage) -> list[dict[str, Any]]:
    """Top-k chunks (above the similarity threshold) for a standalone query."""
    vector = await embed_query(query, usage)
    fetch = config.TOP_K * 2 if config.RERANK else config.TOP_K
    hits = await asyncio.to_thread(store.query, vector, fetch)
    hits = [h for h in hits if h["similarity"] >= config.MIN_SIMILARITY]
    if config.RERANK and len(hits) > 1:
        hits = await _rerank(query, hits, usage)
    return hits[: config.TOP_K]


def summarize_history(previous_summary: str, messages: list[dict[str, Any]]) -> str:
    """Blocking LLM call used by the background compressor (see memory.compress)."""
    transcript = "\n".join(f"{m['role'].capitalize()}: {m['content'][:1500]}" for m in messages)
    prompt = (
        "Update the running summary of a conversation between a user and an assistant. Keep names, "
        "facts, decisions and open questions; drop pleasantries. Max 150 words. Output only the summary.\n\n"
        f"Current summary: {previous_summary or '(none)'}\n\nNew messages:\n{transcript}"
    )
    response = sync_client().chat.completions.create(
        model=config.HELPER_MODEL, messages=[{"role": "user", "content": prompt}], temperature=0, max_tokens=300
    )
    return (response.choices[0].message.content or previous_summary).strip()
