

import asyncio
from pathlib import Path

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from core.kb import attachments, config, guest, memory, plans, store
from core.kb.attachments import Upload
from core.kb.chat import stream_chat
from core.kb.ingest import IngestBusy, ingest_folder, scan
from api.auth import current_user
from api.ratelimit import RateLimiter

router = APIRouter(prefix="/api", tags=["knowledge-base"])

_chat_limiter = RateLimiter(config.CHAT_RATE_LIMIT)
_ingest_limiter = RateLimiter(config.INGEST_RATE_LIMIT)


def _session(x_session_id: str | None) -> str:
    if not memory.valid_session_id(x_session_id):
        raise HTTPException(status_code=400, detail="Missing or invalid X-Session-Id header.")
    return x_session_id  # type: ignore[return-value]


class IngestRequest(BaseModel):
    force: bool = False


# ---- ingestion ----------------------------------------------------------------------------

@router.post("/ingest")
def ingest(body: IngestRequest | None = None, x_session_id: str | None = Header(None)):
    session = _session(x_session_id)
    _ingest_limiter.check(session)
    try:
        return ingest_folder(force=bool(body and body.force), log=lambda _msg: None)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"The documents folder '{config.DOCS_DIR}' doesn't exist. Create it and add PDF, image, TXT, MD or DOCX files.",
        )
    except IngestBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except RuntimeError as exc:  # e.g. missing OPENAI_API_KEY
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/documents")
def documents():
    status = scan()
    return {
        "folder": status["folder"],
        "folder_exists": status["exists"],
        "documents": store.list_documents(),
        "pending": status["pending"],
        "failed": status["failed"],
        "total_chunks": store.count(),
    }


# ---- chat ---------------------------------------------------------------------------------

async def _read_files(files: list[UploadFile]) -> list[Upload]:
    """Read the attached files now: the request's temp files are gone once the endpoint returns."""
    if len(files) > config.MAX_ATTACH_FILES:
        raise HTTPException(status_code=413, detail=f"You can attach up to {config.MAX_ATTACH_FILES} files per message.")
    limit = config.MAX_ATTACH_MB * 1024 * 1024
    uploads: list[Upload] = []
    for f in files:
        data = await f.read(limit + 1)
        name = f.filename or "file"
        if len(data) > limit:
            raise HTTPException(status_code=413, detail=f"{name} is larger than {config.MAX_ATTACH_MB} MB.")
        uploads.append(Upload(name=name, data=data, content_type=f.content_type or ""))
    images = sum(
        1 for u in uploads
        if u.content_type.startswith("image/") or Path(u.name).suffix.lower() in config.IMAGE_EXTENSIONS
    )
    if images > config.MAX_ATTACH_IMAGES:
        raise HTTPException(status_code=413, detail=f"You can attach up to {config.MAX_ATTACH_IMAGES} photos per message.")
    return uploads


async def _account(request: Request) -> dict | None:
    """The logged-in user's document, or None for a guest (guests have a free allowance, see core.kb.guest)."""
    return await asyncio.to_thread(current_user, request)


@router.get("/chat/quota")
async def chat_quota(request: Request, x_session_id: str | None = Header(None)):
    """What the current visitor may still use. Guests: the free allowance. Logged in: today's use on their plan."""
    session = _session(x_session_id)
    user = await _account(request)
    if user is None:
        return {"guest": True, **guest.status(session)}
    return {"guest": False, **plans.status(str(user["_id"]), plans.for_user(user))}


@router.post("/chat")
async def chat(
    request: Request,
    message: str = Form(""),
    conversation_id: str | None = Form(None),
    files: list[UploadFile] = File(default=[]),
    x_session_id: str | None = Header(None),
):
    session = _session(x_session_id)
    _chat_limiter.check(session)

    message = message.strip()
    if len(message) > config.MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=422, detail=f"Message is too long (max {config.MAX_MESSAGE_CHARS} characters).")
    if not message and not files:
        raise HTTPException(status_code=422, detail="Message must not be empty.")

    user = await _account(request)
    is_guest = user is None
    user_id = str(user["_id"]) if user else None
    plan = plans.for_user(user)
    if is_guest:
        reason = guest.check(session, len(files))
        if reason:
            raise HTTPException(status_code=403, detail={"code": "login_required", "message": reason})
    else:
        reason = plans.message_block(user_id, plan)
        if reason:
            raise HTTPException(status_code=403, detail={"code": "plan_limit", "message": reason})
    uploads = await _read_files(files)

    if conversation_id:
        conv = await asyncio.to_thread(memory.store.get, session, conversation_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="Conversation not found.")
    else:
        title = (message or uploads[0].name).replace("\n", " ")[:60]
        conv = memory.new_conversation(session, title)

    return StreamingResponse(
        stream_chat(conv, message, uploads, is_guest, plan, user_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ---- conversations ------------------------------------------------------------------------

@router.get("/conversations")
def list_conversations(x_session_id: str | None = Header(None)):
    return memory.store.list(_session(x_session_id))


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, x_session_id: str | None = Header(None)):
    conv = memory.store.get(_session(x_session_id), conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {k: conv[k] for k in ("id", "title", "created_at", "updated_at", "messages")}


@router.get("/conversations/{conversation_id}/attachments/{attachment_id}")
def get_attachment(conversation_id: str, attachment_id: str, x_session_id: str | None = Header(None)):
    """An image attached in this conversation (used for the thumbnails in the message list)."""
    session = _session(x_session_id)
    conv = memory.store.get(session, conversation_id)
    known = conv and any(
        (a.get("id") == attachment_id and a.get("kind") == "image")
        for m in conv["messages"] for a in m.get("attachments", [])
    )
    path = attachments.image_path(session, conversation_id, attachment_id)
    # Generated pictures (.png) are sent to the browser a moment before their message is saved, so they can't be
    # checked against the conversation yet. They live in this session's own folder, which is protection enough.
    if path is None or not (known or path.suffix == ".png"):
        raise HTTPException(status_code=404, detail="Attachment not found.")
    media_type = "image/png" if path.suffix == ".png" else "image/jpeg"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, x_session_id: str | None = Header(None)):
    if not memory.store.delete(_session(x_session_id), conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"ok": True}


class SpeechRequest(BaseModel):
    text: str = ""


@router.post("/chat/speech")
async def speak(body: SpeechRequest, request: Request):
    """Read an answer aloud. Pro and Premium only; guests and Free get 403."""
    user = await _account(request)
    plan = plans.for_user(user)
    if user is None or not plan.voice_replies:
        raise HTTPException(status_code=403, detail="Spoken replies are part of Pro and Premium.")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="Nothing to read aloud.")
    text = text[: config.SPEECH_MAX_CHARS]
    try:
        from core.kb.clients import async_client

        spoken = await async_client().audio.speech.create(
            model=config.SPEECH_MODEL,
            voice=config.SPEECH_VOICE,
            input=text,
            response_format="mp3",
        )
        audio = spoken.content if hasattr(spoken, "content") else await spoken.aread()
    except Exception:
        raise HTTPException(status_code=502, detail="Couldn't create the voice reply. Please try again.")
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
