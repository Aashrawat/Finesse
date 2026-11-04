import asyncio
import json
import os
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel

from core.kb import attachments, config, guest, memory, plans
from core.kb.attachments import Attachment, Upload
from core.kb.chat import stream_chat
from core.agent.security import actor_for_user, can_read_conversation
from api.auth import current_user
from api.ratelimit import RateLimiter

router = APIRouter(prefix="/api", tags=["chat"])

_chat_limiter = RateLimiter(config.CHAT_RATE_LIMIT)


def _session(x_session_id: str | None) -> str:
    if not memory.valid_session_id(x_session_id):
        raise HTTPException(status_code=400, detail="Missing or invalid X-Session-Id header.")
    return x_session_id  # type: ignore[return-value]


class IngestRequest(BaseModel):
    force: bool = False


# ---- ingestion ----------------------------------------------------------------------------

@router.post("/ingest")
def ingest(body: IngestRequest | None = None, x_session_id: str | None = Header(None)):
    """Retained for older clients; the app no longer writes a shared document index."""
    _session(x_session_id)
    raise HTTPException(
        status_code=410,
        detail="Shared knowledge-base storage is disabled. Attach files to an individual chat instead.",
    )


@router.get("/documents")
def documents():
    """Report the disabled library without opening or scanning the old index."""
    return {
        "enabled": False,
        "folder": "",
        "folder_exists": False,
        "documents": [],
        "pending": [],
        "failed": [],
        "total_chunks": 0,
    }


# ---- chat ---------------------------------------------------------------------------------

def _upload_service(path: str) -> str:
    port = os.getenv("UPLOAD_PORT", "3001")
    base = os.getenv("UPLOAD_SERVICE_URL", f"http://127.0.0.1:{port}").rstrip("/")
    return base + path


def _is_image_upload(name: str, content_type: str) -> bool:
    return content_type.startswith("image/") or Path(name).suffix.lower() in config.IMAGE_EXTENSIONS


def _cloud_prefix() -> str:
    cloud = "".join(os.getenv("CLOUDINARY_CLOUD_NAME", "").split())
    return f"https://res.cloudinary.com/{cloud}/" if cloud else ""


def _hosted_images(raw: str) -> list[Attachment]:
    """Images already stored on Cloudinary. Only the URL and public id are kept on the conversation."""
    if not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Image details were not valid JSON.")
    if not isinstance(data, list):
        raise HTTPException(status_code=422, detail="Image details must be a list.")
    if len(data) > config.MAX_ATTACH_IMAGES:
        raise HTTPException(status_code=413, detail=f"You can attach up to {config.MAX_ATTACH_IMAGES} photos per message.")
    prefix = _cloud_prefix()
    items: list[Attachment] = []
    for item in data:
        if not isinstance(item, dict):
            raise HTTPException(status_code=422, detail="Each image needs a Cloudinary url and public id.")
        url = str(item.get("url") or "")
        public_id = str(item.get("public_id") or "")
        if (
            not prefix
            or not url.startswith(prefix)
            or not public_id.startswith("finesse/")
            or len(public_id) > 300
            or ".." in public_id
            or public_id.startswith("/")
        ):
            raise HTTPException(status_code=422, detail="Each image must be a Cloudinary file from this app.")
        name = Path(str(item.get("name") or "image")).name[:120] or "image"
        mime = str(item.get("mime") or "image/jpeg")[:80]
        if not mime.startswith("image/"):
            mime = "image/jpeg"
        try:
            size = int(item.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        items.append(Attachment(
            id=uuid.uuid4().hex[:12],
            name=name,
            kind="image",
            mime=mime,
            size=max(0, size),
            url=url,
            public_id=public_id,
        ))
    return items


def _forget_cloud_images(public_ids: list[str]) -> None:
    """Best-effort: drop the Cloudinary assets after the conversation document is gone."""
    if not public_ids:
        return
    body = json.dumps({"public_ids": public_ids}).encode()
    req = urllib.request.Request(
        _upload_service("/api/upload/delete"),
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
    except Exception:
        pass


async def _read_files(files: list[UploadFile]) -> list[Upload]:
    """Read the attached documents now: the request's temp files are gone once the endpoint returns.
    Photos are not accepted here; they are uploaded to Cloudinary and only the link is stored."""
    if len(files) > config.MAX_ATTACH_FILES:
        raise HTTPException(status_code=413, detail=f"You can attach up to {config.MAX_ATTACH_FILES} files per message.")
    limit = config.MAX_ATTACH_MB * 1024 * 1024
    uploads: list[Upload] = []
    for f in files:
        name = f.filename or "file"
        content_type = f.content_type or ""
        if _is_image_upload(name, content_type):
            raise HTTPException(
                status_code=400,
                detail="Upload photos first. The chat stores the Cloudinary link, not the image file.",
            )
        data = await f.read(limit + 1)
        if len(data) > limit:
            raise HTTPException(status_code=413, detail=f"{name} is larger than {config.MAX_ATTACH_MB} MB.")
        uploads.append(Upload(name=name, data=data, content_type=content_type))
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
        plan = plans.for_user(None)
        return {"guest": True, **guest.status(session), "model": plan.chat_model, "models": plans.model_options(plan)}
    return {"guest": False, **plans.status(str(user["_id"]), plans.for_user(user))}


@router.post("/upload")
async def upload_images(request: Request):
    """Forward the photo to the Express upload route. The image file is not stored on this server."""
    body = await request.body()
    headers = {"Content-Type": request.headers.get("content-type", "application/octet-stream")}
    session = request.headers.get("x-session-id")
    if session:
        headers["X-Session-Id"] = session
    target = _upload_service("/api/upload")

    def _post() -> tuple[int, str, bytes]:
        req = urllib.request.Request(target, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                media = resp.headers.get("Content-Type", "application/json").split(";")[0]
                return resp.status, media, resp.read()
        except urllib.error.HTTPError as exc:
            media = exc.headers.get("Content-Type", "application/json").split(";")[0]
            return exc.code, media, exc.read()

    try:
        status, media, payload = await asyncio.to_thread(_post)
    except Exception:
        raise HTTPException(status_code=503, detail="Image upload isn't available right now.")
    return Response(content=payload, status_code=status, media_type=media)


@router.post("/chat")
async def chat(
    request: Request,
    message: str = Form(""),
    conversation_id: str | None = Form(None),
    cloud_images: str = Form(""),
    model: str | None = Form(None, max_length=120),
    files: list[UploadFile] = File(default=[]),
    x_session_id: str | None = Header(None),
):
    session = _session(x_session_id)
    _chat_limiter.check(session)

    message = message.strip()
    hosted = _hosted_images(cloud_images)
    if len(message) > config.MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=422, detail=f"Message is too long (max {config.MAX_MESSAGE_CHARS} characters).")
    if not message and not files and not hosted:
        raise HTTPException(status_code=422, detail="Message must not be empty.")

    user = await _account(request)
    is_guest = user is None
    user_id = str(user["_id"]) if user else None
    plan = plans.for_user(user)
    try:
        chosen_model = plans.select_model(plan, model)
    except plans.ModelSelectionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    if is_guest:
        reason = guest.check(session, len(files) + len(hosted))
        if reason:
            raise HTTPException(status_code=403, detail={"code": "login_required", "message": reason})
    else:
        reason = plans.message_block(user_id, plan)
        if reason:
            raise HTTPException(status_code=403, detail={"code": "plan_limit", "message": reason})
    uploads = await _read_files(files)
    if len(uploads) + len(hosted) > config.MAX_ATTACH_FILES:
        raise HTTPException(status_code=413, detail=f"You can attach up to {config.MAX_ATTACH_FILES} files per message.")

    if conversation_id:
        conv = await asyncio.to_thread(memory.store.get, session, conversation_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        if not can_read_conversation(conv, user):
            raise HTTPException(status_code=403, detail="This conversation contains private data and is available only to its authorized owner.")
    else:
        label = message or (uploads[0].name if uploads else hosted[0].name)
        title = label.replace("\n", " ")[:60]
        conv = memory.new_conversation(session, title)

    return StreamingResponse(
        stream_chat(conv, message, uploads, is_guest, plan, user_id, hosted, model=chosen_model, actor=actor_for_user(user)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ---- conversations ------------------------------------------------------------------------

@router.get("/conversations")
def list_conversations(request: Request, x_session_id: str | None = Header(None)):
    items = memory.store.list(_session(x_session_id))
    user = current_user(request) if any(item.get("private_owner") for item in items) else None
    return [{k: item[k] for k in ("id", "title", "created_at", "updated_at")} for item in items if can_read_conversation(item, user)]


def _authorize_conversation(conv: dict | None, request: Request) -> None:
    if conv and conv.get("private_owner") and not can_read_conversation(conv, current_user(request)):
        raise HTTPException(status_code=403, detail="This conversation contains private data and is available only to its authorized owner.")


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, request: Request, x_session_id: str | None = Header(None)):
    conv = memory.store.get(_session(x_session_id), conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    _authorize_conversation(conv, request)
    return {
        **{k: conv[k] for k in ("id", "title", "created_at", "updated_at")},
        "messages": attachments.public_messages(conv),
    }


@router.get("/conversations/{conversation_id}/attachments/{attachment_id}")
def get_attachment(conversation_id: str, attachment_id: str, request: Request, x_session_id: str | None = Header(None)):
    """An image attached in this conversation (used for the thumbnails in the message list)."""
    session = _session(x_session_id)
    conv = memory.store.get(session, conversation_id)
    _authorize_conversation(conv, request)
    hosted_url = ""
    known = False
    if conv:
        for m in conv["messages"]:
            for a in m.get("attachments", []):
                if a.get("id") == attachment_id and a.get("kind") == "image":
                    known = True
                    hosted_url = a.get("url") or ""
    if hosted_url:
        return RedirectResponse(hosted_url)
    path = attachments.image_path(session, conversation_id, attachment_id)
    # Generated pictures (.png) are sent to the browser a moment before their message is saved, so they can't be
    # checked against the conversation yet. They live in this session's own folder, which is protection enough.
    if path is None or not (known or path.suffix == ".png"):
        raise HTTPException(status_code=404, detail="Attachment not found.")
    media_type = "image/png" if path.suffix == ".png" else "image/jpeg"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, request: Request, x_session_id: str | None = Header(None)):
    session = _session(x_session_id)
    conv = memory.store.get(session, conversation_id)
    _authorize_conversation(conv, request)
    if not memory.store.delete(session, conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    public_ids = [
        a["public_id"]
        for m in (conv or {}).get("messages", [])
        for a in m.get("attachments", [])
        if a.get("public_id")
    ]
    _forget_cloud_images(public_ids)
    return {"ok": True}


class SpeechRequest(BaseModel):
    text: str = ""


@router.post("/chat/speech")
async def speak(body: SpeechRequest, request: Request):
    """Read an answer aloud. Pro only; guests and Free get 403."""
    user = await _account(request)
    plan = plans.for_user(user)
    if user is None or not plan.voice_replies:
        raise HTTPException(status_code=403, detail="Spoken replies are part of Pro.")
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
