from dotenv import load_dotenv
load_dotenv()  # must run before importing core modules (they read env vars at import)

import os
import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from api.auth import router as auth_router
from api.jobs import JOBS, collection_name, create_job, forget_chain, get_chain
from api.kb import router as kb_router
from api.research import router as research_router
from api.store import delete_video_file, list_videos, load_video
from core.vector_store import delete_vector_store

UPLOAD_DIR = "uploads"
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".mp4", ".mov", ".mkv", ".webm", ".ogg", ".flac", ".aac"}

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = FastAPI(title="Finesse")

# CORS: the dev server proxies /api, so this only matters when the frontend is served from another
# origin. Set CORS_ORIGINS="https://app.example.com,http://localhost:5173" in .env to change it.
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
def start_job(url: str | None = Form(None), file: UploadFile | None = File(None)):
    original_name = None
    if file is not None and file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"Unsupported file type '{ext}'")
        source = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}{ext}")
        original_name = file.filename
        with open(source, "wb") as out:
            shutil.copyfileobj(file.file, out)
    elif url and re.match(r"^https?://", url.strip()):
        source = url.strip()
    else:
        raise HTTPException(status_code=400, detail="Provide a YouTube/http URL or upload a file")

    return create_job(source, original_name).to_dict()


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


# ---- Frontend (production): serve the built React app from the same origin as /api ----------

DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"

if (DIST_DIR / "index.html").is_file():

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (DIST_DIR / path).resolve()
        if path and candidate.is_file() and DIST_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(DIST_DIR / "index.html")  # client-side routes like /chat/abc
