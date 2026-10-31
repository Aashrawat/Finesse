"""Ingestion pipeline: folder -> load -> chunk -> embed (batched) -> upsert into ChromaDB.

Unchanged documents are skipped by comparing a content hash. The hash also covers the chunking
and embedding settings, so changing them re-ingests everything automatically.

CLI:
    python -m core.kb.ingest                 # ingest ./knowledge_base
    python -m core.kb.ingest path/to/docs    # ingest another folder
    python -m core.kb.ingest --force         # re-embed everything
"""

import argparse
import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path

from core.kb import config, store
from core.kb.chunking import chunk_pages
from core.kb.clients import sync_client
from core.kb.loaders import EmptyDocument, TransientLoadError, load_document

_ingest_lock = threading.Lock()  # one ingestion at a time (CLI and API share this within a process)


class IngestBusy(RuntimeError):
    pass


def _signature() -> str:
    # bump the suffix when chunk metadata or loaders change (meta3: PyMuPDF + vision OCR + images)
    return f"{config.EMBED_MODEL}|{config.CHUNK_TOKENS}|{config.CHUNK_OVERLAP}|{config.VISION_MODEL}|meta3"


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    digest.update(_signature().encode())
    return digest.hexdigest()


def find_files(folder: Path) -> list[Path]:
    files = [
        p for p in folder.rglob("*")
        if p.is_file()
        and p.suffix.lower() in config.SUPPORTED_EXTENSIONS
        and not p.name.startswith(("~$", "."))
    ]
    return sorted(files, key=lambda p: str(p).lower())


def source_name(path: Path, folder: Path) -> str:
    return path.relative_to(folder).as_posix()


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed in batches. The SDK retries rate limits / transient errors with backoff."""
    client = sync_client()
    vectors: list[list[float]] = []
    for i in range(0, len(texts), config.EMBED_BATCH_SIZE):
        batch = texts[i : i + config.EMBED_BATCH_SIZE]
        response = client.embeddings.create(model=config.EMBED_MODEL, input=batch)
        vectors.extend(item.embedding for item in sorted(response.data, key=lambda d: d.index))
    return vectors


def scan(folder: str | Path | None = None) -> dict:
    """What would an ingestion do? (no embedding, no writes)"""
    root = Path(folder or config.DOCS_DIR)
    if not root.is_dir():
        return {"folder": str(root), "exists": False, "pending": [], "failed": [], "files": 0}
    pending, failed_now = [], []
    known_failures = store.load_failed()
    files = find_files(root)
    for path in files:
        source = source_name(path, root)
        digest = file_hash(path)
        if known_failures.get(source, {}).get("hash") == digest:
            failed_now.append({"source": source, "error": known_failures[source]["error"]})
        elif store.source_hash(source) != digest:
            pending.append(source)
    return {"folder": str(root), "exists": True, "pending": pending, "failed": failed_now, "files": len(files)}


def ingest_folder(folder: str | Path | None = None, force: bool = False, log=print) -> dict:
    """Ingest every supported file in `folder`. Returns counts and per-file errors."""
    root = Path(folder or config.DOCS_DIR)
    if not root.is_dir():
        raise FileNotFoundError(f"Folder not found: {root}")
    if not _ingest_lock.acquire(blocking=False):
        raise IngestBusy("An ingestion is already running.")

    summary = {"folder": str(root), "ingested": [], "skipped": [], "errors": [], "chunks": 0}
    try:
        for path in find_files(root):
            source = source_name(path, root)
            try:
                digest = file_hash(path)
                if not force and store.source_hash(source) == digest:
                    summary["skipped"].append(source)
                    log(f"skip    {source} (unchanged)")
                    continue

                try:
                    pages = load_document(path)
                    chunks = chunk_pages(pages)
                except TransientLoadError:
                    raise  # vision/API trouble: reported below but retried next run
                except Exception as exc:  # unreadable file: remember it so it isn't retried or listed as pending
                    reason = str(exc) if isinstance(exc, (EmptyDocument, ValueError)) else f"{type(exc).__name__}: {exc}"
                    store.mark_failed(source, digest, reason)
                    summary["errors"].append({"source": source, "error": reason})
                    log(f"error   {source}: {reason}")
                    continue
                store.clear_failed(source)
                # (embedding errors below are transient, so they are NOT remembered and get retried next run)
                vectors = embed_texts([c.text for c in chunks])

                created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
                ids, metas = [], []
                for index, chunk in enumerate(chunks):
                    chunk_id = f"{source}::{index}"
                    ids.append(chunk_id)
                    metas.append({
                        "source": source,
                        "filename": path.name,
                        "page": chunk.page,
                        "page_end": chunk.page_end,
                        "chunk_id": chunk_id,
                        "chunk_index": index,
                        "created_at": created_at,
                        "doc_hash": digest,
                    })

                # Replace the old version of the document, so removed chunks don't linger
                store.delete_source(source)
                store.upsert_chunks(ids, vectors, [c.text for c in chunks], metas)
                summary["ingested"].append(source)
                summary["chunks"] += len(chunks)
                log(f"ingest  {source} -> {len(chunks)} chunks")
            except Exception as exc:  # one bad file must not stop the rest
                summary["errors"].append({"source": source, "error": f"{type(exc).__name__}: {exc}"})
                log(f"error   {source}: {type(exc).__name__}: {exc}")
        return summary
    finally:
        _ingest_lock.release()


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()
    parser = argparse.ArgumentParser(description="Ingest documents into the knowledge base.")
    parser.add_argument("folder", nargs="?", default=config.DOCS_DIR, help="folder with PDF/image/TXT/MD/DOCX files")
    parser.add_argument("--force", action="store_true", help="re-embed even unchanged documents")
    args = parser.parse_args()
    result = ingest_folder(args.folder, force=args.force)
    print(
        f"\nDone: {len(result['ingested'])} ingested ({result['chunks']} chunks), "
        f"{len(result['skipped'])} unchanged, {len(result['errors'])} failed."
    )
