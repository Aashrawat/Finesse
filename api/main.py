from dotenv import load_dotenv
load_dotenv()  # must run before importing core modules (they read env vars at import)

import os
import shutil
import socket
import subprocess
import time
import uuid
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

import requests as http_requests
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from api.auth import router as auth_router
from api.jobs import JOBS, collection_name, create_job, forget_chain, get_chain
from api.billing import router as billing_router
from api.kb import router as kb_router
from api.plans import router as plans_router
from api.research import router as research_router
from api.store import delete_video_file, list_videos, load_video
from core.vector_store import delete_vector_store
from api.agent import router as agent_router
from core.agent import settings as agent_settings
from core.agent.runtime import mcp_app, mcp_server

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".mp4", ".mov", ".mkv", ".webm", ".ogg", ".flac", ".aac"}

os.makedirs(UPLOAD_DIR, exist_ok=True)


def _upload_port() -> int:
    try:
        return int(os.getenv("UPLOAD_PORT", "3001"))
    except ValueError:
        return 3001


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _start_upload_server() -> subprocess.Popen | None:
    """Start the Express image-upload route (Cloudinary + Multer) beside this API."""
    if os.getenv("UPLOAD_AUTOSTART", "1").strip().lower() in {"0", "false", "no", "off"}:
        return None
    root = Path(__file__).resolve().parent.parent
    script = root / "server" / "index.js"
    node = shutil.which("node")
    if node is None or not script.is_file():
        print("Image upload server was not started (node or server/index.js is missing).", flush=True)
        return None
    port = _upload_port()
    if _port_open(port):
        return None
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    proc = subprocess.Popen([node, str(script)], cwd=str(root), **kwargs)
    deadline = time.time() + 8
    while time.time() < deadline:
        if _port_open(port):
            return proc
        if proc.poll() is not None:
            return None
        time.sleep(0.15)
    return proc


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    proc = _start_upload_server()
    try:
        async with AsyncExitStack() as stack:
            if agent_settings.enabled():
                await stack.enter_async_context(mcp_server.session_manager.run())
            yield
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


app = FastAPI(title="Finesse", lifespan=_lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()],
    allow_credentials=True,  # so the login cookie works if the frontend is served from another listed origin
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(research_router)
app.include_router(kb_router)
app.include_router(plans_router)
app.include_router(billing_router)
app.include_router(agent_router)
if agent_settings.enabled():
    app.mount("/mcp", mcp_app)


class ChatRequest(BaseModel):
    question: str


def _public(video: dict) -> dict:
    """Video as sent to the browser: no server file paths, plus a flag for playable media."""
    data = {k: v for k, v in video.items() if k != "media_path"}
    data["has_media"] = bool(video.get("media_path") and os.path.exists(video["media_path"]))
    return data


def _get_video(video_id: str) -> dict:
    video = load_video(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return video


# ---- Processing jobs -------------------------------------------------------

@app.post("/api/jobs")
def start_job(file: UploadFile | None = File(None)):
    if file is None or not file.filename:
        raise HTTPException(status_code=400, detail="Upload an MP3, MP4 or M4A file")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type '{ext}'")
    source = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}{ext}")
    with open(source, "wb") as out:
        shutil.copyfileobj(file.file, out)
    return create_job(source, file.filename).to_dict()


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if job is not None:
        return job.to_dict()
    if load_video(job_id) is not None:  # finished earlier, e.g. before a server restart
        return {"id": job_id, "status": "done", "stage": "Done", "progress": 100, "error": None, "language": None}
    raise HTTPException(status_code=404, detail="Job not found")


# ---- Videos (archive + workspace) ------------------------------------------

@app.get("/api/videos")
def videos(q: str | None = None):
    return list_videos(q)


@app.get("/api/videos/{video_id}")
def video(video_id: str):
    return _public(_get_video(video_id))


@app.delete("/api/videos/{video_id}")
def delete_video(video_id: str):
    video = _get_video(video_id)
    delete_video_file(video_id)
    forget_chain(video_id)
    try:
        delete_vector_store(collection_name(video_id))
    except Exception:
        pass  # the saved video is already gone; a leftover index is harmless
    media = video.get("media_path")
    if media and os.path.abspath(media).startswith(os.path.abspath(UPLOAD_DIR) + os.sep) and os.path.exists(media):
        os.remove(media)
    return {"ok": True}


@app.get("/api/videos/{video_id}/media")
def media(video_id: str):
    path = _get_video(video_id).get("media_path")
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No playable media for this video")
    return FileResponse(path)


@app.post("/api/videos/{video_id}/chat")
def chat(video_id: str, body: ChatRequest):
    _get_video(video_id)
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is empty")
    return {"answer": get_chain(video_id).invoke(question)}


def _firebase_auth_host() -> str:
    return (os.getenv("FIREBASE_AUTH_DOMAIN") or os.getenv("VITE_FIREBASE_AUTH_DOMAIN") or "").strip()


# Google returns here. We serve Firebase's helper on this same host so the tab is not stuck
# on a blank firebaseapp.com page.
@app.api_route("/__/{rest:path}", methods=["GET", "POST", "HEAD", "OPTIONS"], include_in_schema=False)
async def firebase_auth_helper(rest: str, request: Request):
    host = _firebase_auth_host()
    if not host:
        raise HTTPException(status_code=404, detail="Not found")
    url = f"https://{host}/__/{rest}"
    query = request.url.query
    if query:
        url = f"{url}?{query}"
    skip = {"host", "content-length", "content-encoding", "transfer-encoding", "connection"}
    headers = {key: value for key, value in request.headers.items() if key.lower() not in skip}
    try:
        forwarded = http_requests.request(
            request.method,
            url,
            headers=headers,
            data=await request.body(),
            timeout=20,
            allow_redirects=False,
        )
    except http_requests.RequestException as exc:
        raise HTTPException(status_code=502, detail="Google sign-in isn't available right now.") from exc
    out = {key: value for key, value in forwarded.headers.items() if key.lower() not in skip}
    return Response(content=forwarded.content, status_code=forwarded.status_code, headers=out)


# ---- Frontend (production): serve the built React app from the same origin as /api ----------

DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"

if (DIST_DIR / "index.html").is_file():

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path == "api" or path.startswith("api/") or path == "__" or path.startswith("__/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (DIST_DIR / path).resolve()
        if path and candidate.is_file() and DIST_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(DIST_DIR / "index.html")  # client-side routes like /chat/abc
