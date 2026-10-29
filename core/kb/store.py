"""ChromaDB wrapper: one persistent collection of document chunks with cosine similarity.

We compute embeddings ourselves (OpenAI text-embedding-3-small), so the collection has no
embedding function. Metadata per chunk: source, filename, page, chunk_id, chunk_index,
created_at, doc_hash.
"""

import json
import os
import threading
from functools import lru_cache
from typing import Any

import chromadb

from core.kb import config

_lock = threading.Lock()


@lru_cache(maxsize=1)
def _client() -> chromadb.ClientAPI:
    return chromadb.PersistentClient(path=config.CHROMA_PATH)


def collection():
    return _client().get_or_create_collection(
        name=config.COLLECTION,
        embedding_function=None,
        metadata={"hnsw:space": "cosine"},
    )


def upsert_chunks(
    ids: list[str], embeddings: list[list[float]], documents: list[str], metadatas: list[dict[str, Any]]
) -> None:
    with _lock:
        collection().upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)


def delete_source(source: str) -> None:
    with _lock:
        collection().delete(where={"source": source})


def source_hash(source: str) -> str | None:
    """The doc_hash stored for a source, or None if it isn't in the index."""
    found = collection().get(where={"source": source}, limit=1, include=["metadatas"])
    metas = found.get("metadatas") or []
    return metas[0].get("doc_hash") if metas else None


def query(embedding: list[float], n_results: int) -> list[dict[str, Any]]:
    """Nearest chunks as dicts with text, metadata and cosine `similarity` (1 = identical)."""
    col = collection()
    if col.count() == 0:
        return []
    res = col.query(
        query_embeddings=[embedding],
        n_results=min(n_results, col.count()),
        include=["documents", "metadatas", "distances"],
    )
    out = []
    for text, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0]):
        out.append({"text": text, "metadata": meta, "similarity": 1.0 - float(dist)})
    return out


def list_documents() -> list[dict[str, Any]]:
    """One entry per ingested source, with chunk count and when it was ingested."""
    found = collection().get(include=["metadatas"])
    docs: dict[str, dict[str, Any]] = {}
    for meta in found.get("metadatas") or []:
        doc = docs.setdefault(
            meta["source"],
            {"source": meta["source"], "filename": meta.get("filename", meta["source"]), "chunks": 0,
             "pages": 0, "created_at": meta.get("created_at", ""), "doc_hash": meta.get("doc_hash", "")},
        )
        doc["chunks"] += 1
        doc["pages"] = max(doc["pages"], int(meta.get("page", 0)))
    return sorted(docs.values(), key=lambda d: d["source"].lower())


def count() -> int:
    return collection().count()


# ---- files that could not be read (empty, encrypted, corrupt) -------------------------------
# Remembered by content hash so they aren't reported as "waiting to be ingested" forever.
_FAILED_PATH = os.path.join(os.path.dirname(config.CHROMA_PATH) or ".", "kb_failed.json")


def load_failed() -> dict[str, dict[str, str]]:
    try:
        with open(_FAILED_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_failed(failed: dict[str, dict[str, str]]) -> None:
    os.makedirs(os.path.dirname(_FAILED_PATH) or ".", exist_ok=True)
    with open(_FAILED_PATH, "w", encoding="utf-8") as f:
        json.dump(failed, f)


def mark_failed(source: str, doc_hash: str, error: str) -> None:
    failed = load_failed()
    failed[source] = {"hash": doc_hash, "error": error}
    _save_failed(failed)


def clear_failed(source: str) -> None:
    failed = load_failed()
    if failed.pop(source, None) is not None:
        _save_failed(failed)
