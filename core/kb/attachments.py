
import asyncio
import base64
import json
import os
import urllib.request
import re
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from core.kb import config
from core.kb.chunking import chunk_pages, count_tokens
from core.kb.loaders import EmptyDocument, TransientLoadError, load_document, prepare_image
from core.kb.retrieval import Usage, embed_query

DOC_EXTENSIONS = {".pdf", ".txt", ".md", ".docx"}
_ID_RE = re.compile(r"^[0-9a-f]{12}$")


class AttachmentError(Exception):
    """A file could not be used. The message is written for the user."""


@dataclass
class Upload:
    name: str
    data: bytes
    content_type: str = ""


@dataclass
class Attachment:
    id: str
    name: str
    kind: str  # "image" | "document"
    mime: str
    size: int
    jpeg: bytes = b""  # images prepared in memory for this turn; not written to disk when a Cloudinary url is set
    pages: list[tuple[int, str]] = field(default_factory=list)  # documents: (page, text), page 0 = no pages
    url: str = ""  # Cloudinary secure URL (images)
    public_id: str = ""  # Cloudinary public id (images)

    def meta(self) -> dict[str, Any]:
        data = {"id": self.id, "name": self.name, "kind": self.kind, "mime": self.mime, "size": self.size}
        if self.url:
            data["url"] = self.url
        if self.public_id:
            data["public_id"] = self.public_id
        return data


# --------------------------------------------------------------------------- reading uploads
def _why(cause: BaseException | None) -> str:
    """A short, readable reason for a failed vision call (the raw API error text is not for users)."""
    import openai

    if isinstance(cause, openai.AuthenticationError):
        return "the OpenAI API key was rejected, check OPENAI_API_KEY"
    if isinstance(cause, openai.RateLimitError):
        return "OpenAI is rate limiting this key"
    if isinstance(cause, (openai.APIConnectionError, openai.APITimeoutError)):
        return "couldn't reach OpenAI"
    if isinstance(cause, RuntimeError):
        return str(cause)  # e.g. OPENAI_API_KEY is not set
    return type(cause).__name__ if cause else "unknown error"


def _kind(upload: Upload) -> str:
    ext = Path(upload.name).suffix.lower()
    if upload.data[:5] == b"%PDF-" or ext in DOC_EXTENSIONS:
        return "document"
    if ext in config.IMAGE_EXTENSIONS or upload.content_type.startswith("image/"):
        return "image"
    raise AttachmentError(f"{upload.name}: unsupported file type. Attach a PDF, image, TXT, MD or DOCX file.")


def read_upload(upload: Upload) -> Attachment:
    """Blocking: parse one uploaded file (may call the vision model for scanned pages)."""
    name = Path(upload.name or "file").name[:120] or "file"
    upload.name = name
    if not upload.data:
        raise AttachmentError(f"{name}: the file is empty.")
    kind = _kind(upload)
    att_id = uuid.uuid4().hex[:12]

    if kind == "image":
        try:
            jpeg = prepare_image(upload.data)
        except ValueError as exc:
            raise AttachmentError(f"{name}: {exc}") from exc
        return Attachment(att_id, name, "image", "image/jpeg", len(upload.data), jpeg=jpeg)

    ext = Path(name).suffix.lower()
    if upload.data[:5] == b"%PDF-":
        ext = ".pdf"
    # ignore_cleanup_errors: on Windows a PDF library can still hold a corrupt file open for a moment
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        path = Path(tmp) / f"file{ext}"
        path.write_bytes(upload.data)
        try:
            pages = load_document(path)
        except EmptyDocument as exc:
            raise AttachmentError(f"{name}: no readable text was found in this file.") from exc
        except TransientLoadError as exc:
            raise AttachmentError(f"{name}: couldn't be read right now ({_why(exc.__cause__)}). Please try again.") from exc
        except ValueError as exc:
            raise AttachmentError(f"{name}: {exc}") from exc
        except Exception as exc:
            raise AttachmentError(f"{name}: could not be read ({type(exc).__name__}).") from exc
    mime = "application/pdf" if ext == ".pdf" else "text/plain"
    return Attachment(att_id, name, "document", mime, len(upload.data), pages=pages)


# --------------------------------------------------------------------------- storage
def conversation_dir(session_id: str, conversation_id: str) -> Path:
    return Path(config.CHATS_DIR) / session_id / conversation_id


def _path(session_id: str, conversation_id: str, att_id: str, suffix: str) -> Path:
    if not _ID_RE.match(att_id):
        raise ValueError("bad attachment id")
    return conversation_dir(session_id, conversation_id) / f"{att_id}{suffix}"


def save(session_id: str, conversation_id: str, items: list[Attachment]) -> bool:
    """Write document text beside the conversation. Images with a Cloudinary url are not saved as files.
    Returns True when a file was written."""
    wrote = False
    folder_ready = False

    def ensure() -> None:
        nonlocal folder_ready
        if not folder_ready:
            conversation_dir(session_id, conversation_id).mkdir(parents=True, exist_ok=True)
            folder_ready = True

    for a in items:
        if a.kind == "image":
            if a.url:
                continue
            ensure()
            _path(session_id, conversation_id, a.id, ".jpg").write_bytes(a.jpeg)
            wrote = True
        else:
            ensure()
            _path(session_id, conversation_id, a.id, ".doc.json").write_text(
                json.dumps(a.pages, ensure_ascii=False), encoding="utf-8"
            )
            wrote = True
    return wrote


def release_hosted(items: list[Attachment]) -> None:
    """Remove Cloudinary images for a turn that was never stored on the conversation."""
    ids = [a.public_id for a in items if a.public_id]
    if not ids:
        return
    port = os.getenv("UPLOAD_PORT", "3001")
    url = os.getenv("UPLOAD_SERVICE_URL", f"http://127.0.0.1:{port}").rstrip("/") + "/api/upload/delete"
    req = urllib.request.Request(
        url,
        data=json.dumps({"public_ids": ids}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
    except Exception:
        pass


def discard(session_id: str, conversation_id: str, items: list[Attachment]) -> None:
    """Remove files of a turn that was never saved."""
    for a in items:
        for suffix in (".jpg", ".doc.json", ".vec.json"):
            try:
                _path(session_id, conversation_id, a.id, suffix).unlink(missing_ok=True)
            except ValueError:
                pass
    try:
        conversation_dir(session_id, conversation_id).rmdir()  # only succeeds when empty
    except OSError:
        pass


def image_path(session_id: str, conversation_id: str, att_id: str) -> Path | None:
    """An image of this conversation: a photo the user attached (.jpg) or one the chatbot generated (.png)."""
    for suffix in (".jpg", ".png"):
        try:
            path = _path(session_id, conversation_id, att_id, suffix)
        except ValueError:
            return None
        if path.is_file():
            return path
    return None


def save_generated(session_id: str, conversation_id: str, png: bytes) -> str:
    """Store an image the chatbot made. Returns its id."""
    att_id = uuid.uuid4().hex[:12]
    conversation_dir(session_id, conversation_id).mkdir(parents=True, exist_ok=True)
    _path(session_id, conversation_id, att_id, ".png").write_bytes(png)
    return att_id


def discard_generated(session_id: str, conversation_id: str, att_id: str) -> None:
    """Remove a generated image whose turn was never stored."""
    try:
        _path(session_id, conversation_id, att_id, ".png").unlink(missing_ok=True)
        conversation_dir(session_id, conversation_id).rmdir()  # only succeeds when empty
    except (ValueError, OSError):
        pass


def _attachments_of(conv: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [a for m in conv["messages"] for a in m.get("attachments", []) if a.get("kind") == kind]


def has_files(conv: dict[str, Any], new: list[Attachment]) -> bool:
    return bool(new) or any(m.get("attachments") for m in conv["messages"])


def public_messages(conv: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep source cards only for documents attached before that answer in this chat.

    Older saves may contain shared-library hits (filename::chunk). Conversation attachments
    use attachment-id::chunk instead. Filter the response without rewriting the saved history.
    """
    document_ids: set[str] = set()
    messages = []
    for message in conv["messages"]:
        document_ids.update(
            a["id"] for a in message.get("attachments", []) if a.get("kind") == "document"
        )
        sources = [
            source for source in message.get("sources", [])
            if str(source.get("chunk_id", "")).partition("::")[0] in document_ids
        ]
        messages.append({**message, "sources": sources})
    return messages


# --------------------------------------------------------------------------- images in the prompt
def _data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()


def image_part(jpeg: bytes) -> dict[str, Any]:
    return {"type": "image_url", "image_url": {"url": _data_url(jpeg), "detail": "auto"}}


def image_content(attachment: Attachment) -> dict[str, Any]:
    """A vision part. Hosted images are sent as their Cloudinary URL; no file is read from disk."""
    if attachment.url:
        return {"type": "image_url", "image_url": {"url": attachment.url, "detail": "auto"}}
    return image_part(attachment.jpeg)


def history_messages(conv: dict[str, Any], resend_images: bool = True, plan=None) -> list[dict[str, Any]]:
    """Recent turns as chat messages. Earlier attachments stay in context: their names are noted, and the
    latest few images are shown again so follow-up questions about them work. Pass resend_images=False when
    the new message brings its own files, so old pictures don't compete with them."""
    from core.kb import memory

    window = memory.recent_messages(conv, plan)
    # which images get re-sent: the most recent HISTORY_IMAGES in the window
    image_ids = [a["id"] for m in window for a in m.get("attachments", []) if a.get("kind") == "image"]
    resend = set(image_ids[-config.HISTORY_IMAGES:]) if resend_images and config.HISTORY_IMAGES > 0 else set()

    out: list[dict[str, Any]] = []
    for m in window:
        atts = m.get("attachments", [])
        if m["role"] != "user" or not atts:
            out.append({"role": m["role"], "content": m["content"]})
            continue
        note = "[Attached: " + ", ".join(a["name"] for a in atts) + "]"
        text = f"{note}\n{m['content']}".strip()
        parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
        for a in atts:
            if a["id"] not in resend:
                continue
            if a.get("url"):
                parts.append({"type": "image_url", "image_url": {"url": a["url"], "detail": "auto"}})
                continue
            path = image_path(conv["session_id"], conv["id"], a["id"])
            if path:
                parts.append(image_part(path.read_bytes()))
        out.append({"role": "user", "content": parts if len(parts) > 1 else text})
    return out


# --------------------------------------------------------------------------- documents in the prompt
@dataclass
class _Doc:
    id: str
    name: str
    pages: list[tuple[int, str]]


def earlier_documents(conv: dict[str, Any]) -> list[str]:
    """Names of the documents attached in earlier messages of this conversation."""
    return [a["name"] for a in _attachments_of(conv, "document")]


def _load_docs(conv: dict[str, Any], new: list[Attachment]) -> list[_Doc]:
    """The documents the answer may use. A document attached with this message replaces the earlier ones
    so a question about the new file is not answered from the old ones too.
    A follow-up question without a new document uses the documents of the most recent message that had some."""
    fresh = [_Doc(a.id, a.name, a.pages) for a in new if a.kind == "document"]
    if fresh:
        return fresh
    latest: list[dict[str, Any]] = []
    for message in reversed(conv["messages"]):
        latest = [a for a in message.get("attachments", []) if a.get("kind") == "document"]
        if latest:
            break
    docs: list[_Doc] = []
    for a in latest:
        path = _path(conv["session_id"], conv["id"], a["id"], ".doc.json")
        if path.is_file():
            pages = [(int(p), str(t)) for p, t in json.loads(path.read_text(encoding="utf-8"))]
            docs.append(_Doc(a["id"], a["name"], pages))
    return docs


def _full_text(doc: _Doc) -> str:
    body = "\n\n".join(f"[Page {p}]\n{t}" if p > 0 else t for p, t in doc.pages)
    return f"=== Attached document: {doc.name} ===\n{body}"


def _vectors(session_id: str, conversation_id: str, doc: _Doc) -> tuple[list[dict[str, Any]], np.ndarray]:
    """Chunks + embeddings of a long document, computed once and cached beside it."""
    cache = _path(session_id, conversation_id, doc.id, ".vec.json")
    if cache.is_file():
        data = json.loads(cache.read_text(encoding="utf-8"))
        return data["chunks"], np.array(data["vectors"], dtype=np.float32)

    from core.kb.clients import embed_texts

    chunks = [{"text": c.text, "page": c.page, "page_end": c.page_end} for c in chunk_pages(doc.pages)]
    vectors = embed_texts([c["text"] for c in chunks])
    cache.write_text(json.dumps({"chunks": chunks, "vectors": vectors}), encoding="utf-8")
    return chunks, np.array(vectors, dtype=np.float32)


def _cite(name: str, page: int, page_end: int) -> str:
    if page <= 0:
        return f"[source: {name}]"
    return f"[source: {name}, page {page}]" if page_end == page else f"[source: {name}, pages {page}-{page_end}]"


def _search(conv: dict[str, Any], docs: list[_Doc], query_vector: list[float]) -> tuple[str, list[dict[str, Any]]]:
    q = np.array(query_vector, dtype=np.float32)
    q /= np.linalg.norm(q) or 1.0
    scored: list[tuple[float, _Doc, int, dict[str, Any]]] = []
    for doc in docs:
        chunks, matrix = _vectors(conv["session_id"], conv["id"], doc)
        if not len(chunks):
            continue
        norms = np.linalg.norm(matrix, axis=1)
        norms[norms == 0] = 1.0
        sims = (matrix / norms[:, None]) @ q
        scored += [(float(s), doc, i, chunks[i]) for i, s in enumerate(sims)]
    scored.sort(key=lambda t: t[0], reverse=True)
    top = scored[: config.ATTACH_TOP_K]

    blocks = [f"{_cite(d.name, c['page'], c['page_end'])}\n{c['text']}" for _, d, _, c in top]
    sources = [
        {
            "source": d.name, "filename": d.name, "page": c["page"], "page_end": c["page_end"],
            "chunk_id": f"{d.id}::{i}", "similarity": round(max(0.0, s), 3), "text": c["text"][:400],
        }
        for s, d, i, c in top
    ]
    context = (
        "The attached documents are long, so only the passages most relevant to the question are shown:\n\n"
        + "\n\n---\n\n".join(blocks)
    )
    return context, sources


async def document_context(
    conv: dict[str, Any], new: list[Attachment], query: str, usage: Usage
) -> tuple[str, list[dict[str, Any]]]:
    """Text of the conversation's documents for the prompt, plus source cards (only when passages are picked)."""
    docs = await asyncio.to_thread(_load_docs, conv, new)
    if not docs:
        return "", []

    def total_tokens() -> int:
        return sum(count_tokens(t) for d in docs for _, t in d.pages)

    if await asyncio.to_thread(total_tokens) <= config.ATTACH_FULL_TOKENS:
        return "\n\n".join(_full_text(d) for d in docs), []

    vector = await embed_query(query, usage)
    return await asyncio.to_thread(_search, conv, docs, vector)
