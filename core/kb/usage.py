"""How many messages and images each logged-in user has used today (for the daily limits of their plan).

Kept in a small JSON file keyed by user id, so a server restart doesn't hand out a fresh allowance. A user's
entry starts again on a new day (UTC) and old entries are dropped.
"""

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from core.kb import config

_lock = threading.Lock()
_data: dict[str, dict[str, Any]] | None = None


def _day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _load() -> dict[str, dict[str, Any]]:
    global _data
    if _data is None:
        try:
            with open(config.PLAN_USAGE_PATH, encoding="utf-8") as f:
                _data = json.load(f)
        except (OSError, ValueError):
            _data = {}
    return _data


def _save(data: dict[str, dict[str, Any]]) -> None:
    keep_from = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
    for key in [k for k, v in data.items() if str(v.get("day", "")) < keep_from]:
        del data[key]
    os.makedirs(os.path.dirname(config.PLAN_USAGE_PATH) or ".", exist_ok=True)
    tmp = f"{config.PLAN_USAGE_PATH}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, config.PLAN_USAGE_PATH)  # atomic: a crash never leaves a half-written file


def today(user_id: str) -> tuple[int, int]:
    """(messages, images) this user has used today."""
    with _lock:
        entry = _load().get(user_id)
    if not entry or entry.get("day") != _day():
        return 0, 0
    return int(entry.get("messages", 0)), int(entry.get("images", 0))


def record(user_id: str, messages: int = 0, images: int = 0) -> None:
    """Add to today's use."""
    if messages <= 0 and images <= 0:
        return
    with _lock:
        data = _load()
        entry = data.get(user_id)
        if not entry or entry.get("day") != _day():
            entry = {"day": _day(), "messages": 0, "images": 0}
        entry["messages"] = int(entry["messages"]) + max(0, messages)
        entry["images"] = int(entry["images"]) + max(0, images)
        data[user_id] = entry
        _save(data)
