"""Shared OpenAI clients. The SDK retries 429 / 5xx / connection errors with exponential backoff."""

import asyncio
import os
import weakref
from functools import lru_cache

from openai import AsyncOpenAI, OpenAI

from core.kb import config


def _key() -> str:
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set. Add it to your .env file.")
    return key


@lru_cache(maxsize=1)
def sync_client() -> OpenAI:
    return OpenAI(api_key=_key(), max_retries=config.OPENAI_MAX_RETRIES, timeout=config.OPENAI_TIMEOUT)


_async_clients: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, AsyncOpenAI]" = weakref.WeakKeyDictionary()


def async_client() -> AsyncOpenAI:
    """One AsyncOpenAI per running event loop (its connection pool is bound to the loop it was made in)."""
    loop = asyncio.get_running_loop()
    client = _async_clients.get(loop)
    if client is None:
        client = AsyncOpenAI(api_key=_key(), max_retries=config.OPENAI_MAX_RETRIES, timeout=config.OPENAI_TIMEOUT)
        _async_clients[loop] = client
    return client
