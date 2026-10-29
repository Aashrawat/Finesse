"""Background processing. One worker thread: Whisper on CPU can only run one job at a time."""
import os
import re
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

from api.store import save_video
from utils.audio_processor import process_input
from core.transcriber import detect_language, transcribe_chunk_full
from core.summarizer import summarize, generate_title
from core.extractor import extract_action_items, extract_key_decisions, extract_questions
from core.rag_engine import build_rag_chain, load_rag_chain

_executor = ThreadPoolExecutor(max_workers=1)

CHUNK_SECONDS = 600       # utils.audio_processor.chunk_audio splits audio into 10-minute chunks
CUT_SECONDS = 25          # merge Whisper's short segments into ~25s "cuts" for the transcript view
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm"}

_YOUTUBE_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/)|youtu\.be/)([\w-]{11})"
)


@dataclass
class Job:
    id: str
    source: str
    original_name: str | None = None
    status: str = "queued"      # queued | running | done | error
    stage: str = "Queued"
    progress: int = 0           # 0-100
    error: str | None = None
    language: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "error": self.error,
            "language": self.language,
        }


JOBS: dict[str, Job] = {}
_CHAINS: dict[str, object] = {}


def collection_name(video_id: str) -> str:
    return f"video_{video_id}"


def get_chain(video_id: str):
    """Chat chain for a saved video (rebuilt from its saved index after a server restart)."""
    if video_id not in _CHAINS:
        _CHAINS[video_id] = load_rag_chain(collection_name(video_id))
    return _CHAINS[video_id]


def forget_chain(video_id: str) -> None:
    _CHAINS.pop(video_id, None)


def create_job(source: str, original_name: str | None = None) -> Job:
    job = Job(id=uuid.uuid4().hex[:12], source=source, original_name=original_name)
    JOBS[job.id] = job
    _executor.submit(_run, job)
    return job


def _set(job: Job, stage: str, progress: int) -> None:
    job.stage, job.progress = stage, progress


def _clock(seconds: float) -> str:
    s = int(seconds)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def _merge_segments(raw: list[dict]) -> list[dict]:
    merged, cur = [], None
    for seg in raw:
        text = seg["text"].strip()
        if not text:
            continue
        if cur is None:
            cur = {"start": seg["start"], "end": seg["end"], "speaker": "Speaker 1", "text": text}
        else:
            cur["end"] = seg["end"]
            cur["text"] += " " + text
        if cur["end"] - cur["start"] >= CUT_SECONDS:
            merged.append(cur)
            cur = None
    if cur:
        merged.append(cur)
    return merged


def _cleanup_audio(chunks: list[str]) -> None:
    """Remove the temporary WAV chunks (and the WAV they were cut from). The original upload is kept."""
    paths = set(chunks)
    for chunk in chunks:
        paths.add(chunk[: chunk.rfind("_chunk_")])
    for path in paths:
        try:
            os.remove(path)
        except OSError:
            pass


def _run(job: Job) -> None:
    chunks: list[str] = []
    try:
        job.status = "running"

        _set(job, "Preparing audio", 5)
        chunks = process_input(job.source)

        _set(job, "Detecting language", 12)
        job.language = detect_language(chunks[0])
        translate = job.language != "en"

        raw_segments = []
        for i, chunk in enumerate(chunks):
            label = "Transcribing + translating" if translate else "Transcribing"
            _set(job, f"{label} (part {i + 1} of {len(chunks)})", 15 + int(55 * i / len(chunks)))
            result = transcribe_chunk_full(chunk, translate=translate)
            offset = i * CHUNK_SECONDS
            raw_segments += [
                {"start": s["start"] + offset, "end": s["end"] + offset, "text": s["text"]}
                for s in result["segments"]
            ]

        segments = _merge_segments(raw_segments)
        if not segments:
            raise ValueError("No speech was detected in this recording")

        transcript = "\n".join(s["text"] for s in segments)
        timestamped = "\n".join(f"[{_clock(s['start'])}] {s['text']}" for s in segments)

        _set(job, "Writing summary", 72)
        title = generate_title(transcript)
        summary = summarize(transcript)

        _set(job, "Extracting action items and decisions", 84)
        action_items = extract_action_items(transcript)
        decisions = extract_key_decisions(transcript)
        questions = extract_questions(transcript)

        _set(job, "Preparing chat", 94)
        _CHAINS[job.id] = build_rag_chain(timestamped, collection_name(job.id))

        is_url = job.source.startswith(("http://", "https://"))
        youtube_id = None
        if is_url:
            match = _YOUTUBE_RE.search(job.source)
            youtube_id = match.group(1) if match else None
            source_type, source_ref = "youtube", job.source
            media_path = None
        else:
            ext = os.path.splitext(job.source)[1].lower()
            source_type = "video" if ext in VIDEO_EXTENSIONS else "audio"
            source_ref = job.original_name or os.path.basename(job.source)
            media_path = job.source

        save_video({
            "id": job.id,
            "title": title,
            "source_type": source_type,
            "source_ref": source_ref,
            "thumbnail": f"https://i.ytimg.com/vi/{youtube_id}/hqdefault.jpg" if youtube_id else None,
            "duration": segments[-1]["end"],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "youtube_id": youtube_id,
            "language": job.language,
            "summary_text": summary,
            "action_items": action_items,
            "decisions": decisions,
            "questions": questions,
            "transcript": segments,
            "media_path": media_path,   # server-side only, never sent to the browser
        })

        _set(job, "Done", 100)
        job.status = "done"
    except Exception as exc:  # show the failure in the UI instead of failing silently
        traceback.print_exc()
        job.status = "error"
        job.error = f"{type(exc).__name__}: {exc}"
    finally:
        _cleanup_audio(chunks)
