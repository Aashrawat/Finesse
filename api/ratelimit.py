"""Small in-memory sliding-window rate limiter (per key, e.g. per user session)."""

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException


class RateLimiter:
    def __init__(self, limit: int, window_seconds: int = 60):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> None:
        """Raise 429 (with Retry-After) when `key` has used up its requests in the window."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                retry_after = max(1, int(self.window - (now - hits[0])) + 1)
                raise HTTPException(
                    status_code=429,
                    detail=f"Too many requests. Please wait {retry_after}s and try again.",
                    headers={"Retry-After": str(retry_after)},
                )
            hits.append(now)
            if len(self._hits) > 5000:  # forget idle keys so this can't grow forever
                for stale in [k for k, v in self._hits.items() if not v or now - v[-1] > self.window]:
                    self._hits.pop(stale, None)
