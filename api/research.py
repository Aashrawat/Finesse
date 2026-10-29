"""HTTP endpoints for the multi-agent research feature.

Runs `core.research.pipeline` as a background job (polled by the UI) and keeps finished
reports as JSON files so they survive restarts, like the video archive does.
"""
import json
import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.research.pipeline import run_research_pipeline
from core.research.tools import MissingApiKey, require_tavily_key

RESEARCH_DIR = os.path.join("data", "research")
os.makedirs(RESEARCH_DIR, exist_ok=True)
_ID_RE = re.compile(r"^[0-9a-f]{12}$")

router = APIRouter(prefix="/api/research", tags=["research"])
_executor = ThreadPoolExecutor(max_workers=1)  # one research run at a time keeps API usage predictable
_jobs: dict[str, dict] = {}  # running / just-finished jobs (finished ones are also on disk)


class ResearchRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=500)


def _path(research_id: str) -> str | None:
    return os.path.join(RESEARCH_DIR, f"{research_id}.json") if _ID_RE.match(research_id) else None


def _load(research_id: str) -> dict | None:
    path = _path(research_id)
    if path is None or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _run(research_id: str) -> None:
    job = _jobs[research_id]

    def on_step(n: int) -> None:
        job["step"] = n

    try:
        state = run_research_pipeline(job["topic"], on_step=on_step)
        job.update(
            status="done",
            step=5,
            result={key: state.get(key, "") for key in ("search_results", "scraped_content", "report", "feedback")},
        )
        with open(_path(research_id), "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False)
    except Exception as exc:  # surface any pipeline failure to the UI
        job.update(status="error", error=str(exc) if isinstance(exc, MissingApiKey) else f"{type(exc).__name__}: {exc}")


@router.post("")
def start_research(body: ResearchRequest):
    topic = body.topic.strip()
    if not topic:
        raise HTTPException(status_code=422, detail="Topic must not be empty.")
    try:
        require_tavily_key()
    except MissingApiKey as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    research_id = uuid.uuid4().hex[:12]
    _jobs[research_id] = {
        "id": research_id,
        "topic": topic,
        "status": "running",
        "step": 0,  # 0 = starting, 1-4 = pipeline step, 5 = finished
        "created_at": time.time(),
        "result": None,
        "error": None,
    }
    _executor.submit(_run, research_id)
    return _jobs[research_id]


@router.get("")
def list_research():
    items = []
    for name in os.listdir(RESEARCH_DIR):
        if name.endswith(".json"):
            item = _load(name[:-5])
            if item:
                items.append({key: item.get(key) for key in ("id", "topic", "created_at")})
    return sorted(items, key=lambda r: r["created_at"], reverse=True)


@router.get("/{research_id}")
def get_research(research_id: str):
    job = _jobs.get(research_id) or _load(research_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Research not found")
    return job


@router.delete("/{research_id}")
def delete_research(research_id: str):
    path = _path(research_id)
    if path is None or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Research not found")
    os.remove(path)
    _jobs.pop(research_id, None)
    return {"ok": True}
