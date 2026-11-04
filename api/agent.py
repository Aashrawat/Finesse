"""Read-only diagnostics for the tools available to the current account."""
import os

from fastapi import APIRouter, Request

from api.auth import current_user
from core.agent import settings
from core.agent.client import open_tools
from core.agent.security import actor_for_user

router = APIRouter(prefix="/api/agent", tags=["agent"])


@router.get("/status")
def status(request: Request):
    return {"enabled": settings.enabled(), "google_search": settings.enabled() and bool(os.getenv("SERPAPI_API_KEY", "").strip()),
            "wikipedia": settings.enabled(),
            "max_tool_calls": settings.MAX_CALLS, "max_rounds": settings.MAX_ROUNDS}


@router.get("/tools")
async def tools(request: Request):
    import asyncio
    user = await asyncio.to_thread(current_user, request)
    async with open_tools(actor_for_user(user)) as broker:
        return {"tools": [{"name": tool.name, "description": tool.description} for tool in broker.tools.values()],
                "unavailable_servers": broker.unavailable}
