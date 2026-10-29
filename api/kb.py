

import asyncio

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.kb import config, memory, store
from core.kb.chat import stream_chat
from core.kb.ingest import IngestBusy, ingest_folder, scan
from api.ratelimit import RateLimiter

router = APIRouter(prefix="/api", tags=["knowledge-base"])

_chat_limiter = RateLimiter(config.CHAT_RATE_LIMIT)
_ingest_limiter = RateLimiter(config.INGEST_RATE_LIMIT)


def _session(x_session_id: str | None) -> str:
    if not memory.valid_session_id(x_session_id):
        raise HTTPException(status_code=400, detail="Missing or invalid X-Session-Id header.")
    return x_session_id  # type: ignore[return-value]


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=config.MAX_MESSAGE_CHARS)
    conversation_id: str | None = None


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
            detail=f"The documents folder '{config.DOCS_DIR}' doesn't exist. Create it and add PDF, TXT, MD or DOCX files.",
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

@router.post("/chat")
async def chat(body: ChatRequest, request: Request, x_session_id: str | None = Header(None)):
    session = _session(x_session_id)
    _chat_limiter.check(session)

    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Message must not be empty.")

    if body.conversation_id:
        conv = await asyncio.to_thread(memory.store.get, session, body.conversation_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="Conversation not found.")
    else:
        title = message.replace("\n", " ")[:60]
        conv = memory.new_conversation(session, title)

    return StreamingResponse(
        stream_chat(conv, message),
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


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, x_session_id: str | None = Header(None)):
    if not memory.store.delete(_session(x_session_id), conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"ok": True}
