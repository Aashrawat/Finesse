"""Finished videos are saved as JSON files so the archive survives server restarts."""
import json
import os
import re

VIDEO_DIR = os.path.join("data", "videos")
os.makedirs(VIDEO_DIR, exist_ok=True)

_ID_RE = re.compile(r"^[0-9a-f]{12}$")  # ids become filenames, so only allow our own format

LIST_FIELDS = ("id", "title", "source_type", "source_ref", "thumbnail", "duration", "created_at")


def _path(video_id: str) -> str | None:
    return os.path.join(VIDEO_DIR, f"{video_id}.json") if _ID_RE.match(video_id) else None


def save_video(video: dict) -> None:
    with open(_path(video["id"]), "w", encoding="utf-8") as f:
        json.dump(video, f, ensure_ascii=False)


def load_video(video_id: str) -> dict | None:
    path = _path(video_id)
    if path is None or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def list_videos(query: str | None = None) -> list[dict]:
    items = []
    for name in os.listdir(VIDEO_DIR):
        if not name.endswith(".json"):
            continue
        video = load_video(name[:-5])
        if video is None:
            continue
        if query and query.lower() not in video["title"].lower():
            continue
        items.append({key: video.get(key) for key in LIST_FIELDS})
    return sorted(items, key=lambda v: v["created_at"], reverse=True)


def delete_video_file(video_id: str) -> None:
    path = _path(video_id)
    if path and os.path.exists(path):
        os.remove(path)
