"""Verify real MCP HTTP discovery, optionally probe Google/Wikipedia or run a paid model-assisted question.

This self-contained check mounts the same MCP app with ASGI HTTP transport. It never saves a chat,
accesses private records, or modifies external resources. --question uses the configured provider API key.
"""
import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

import httpx
from starlette.applications import Starlette
from starlette.routing import Mount

from core.agent import runner
from core.agent.client import open_tools
from core.agent.security import Actor
from core.agent.server import create_server
from core.kb import config, plans
from core.kb.retrieval import Usage


async def check(args):
    from contextlib import asynccontextmanager
    from unittest.mock import patch

    server = create_server()
    app = Starlette(routes=[Mount("/mcp", app=server.streamable_http_app())])
    actor = Actor("local-diagnostic")
    transport = httpx.ASGITransport(app=app)

    @asynccontextmanager
    async def in_process_tools(_actor):
        async with open_tools(actor, transport) as broker:
            yield broker

    async with server.session_manager.run():
        async with open_tools(actor, transport) as broker:
            print("Discovered read-only tools:", ", ".join(broker.tools))
            if broker.unavailable:
                raise RuntimeError("One or more configured MCP servers were unavailable.")
            if args.probe_google:
                if "local__google_search" not in broker.tools:
                    print("Google Search probe failed: enable MCP and set SERPAPI_API_KEY in the backend environment.", file=sys.stderr)
                    return 1
                result = await broker.call("local__google_search", {"query": "Cristiano Ronaldo Wikipedia", "limit": 1})
                data = result.get("untrusted_data", result)
                if data.get("error"):
                    print("Google Search probe failed:", data["error"], file=sys.stderr)
                    return 1
                print("Google Search probe:", len(data.get("sources", [])), "source(s) returned")
            if args.probe:
                result = await broker.call("local__wikipedia_search", {"query": "Albert Einstein", "limit": 1})
                data = result.get("untrusted_data", result)
                if data.get("error"):
                    print("Wikipedia probe failed:", data["error"], file=sys.stderr)
                    return 1
                if not data.get("sources"):
                    print("Wikipedia probe failed: no sources returned.", file=sys.stderr)
                    return 1
                print("Wikipedia probe:", data["sources"][0]["title"])
        if args.question:
            usage = Usage()
            with patch.object(runner, "open_tools", side_effect=in_process_tools):
                async for kind, payload in runner.run([
                    {"role": "system", "content": config.SYSTEM_PROMPT}, {"role": "user", "content": args.question},
                ], args.model, actor, usage):
                    if kind == "token":
                        print(payload["t"], end="", flush=True)
                    elif kind == "status":
                        print("\n" + payload["text"], flush=True)
                    elif kind == "external_sources":
                        print("\nSources:", ", ".join(source["url"] for source in payload["sources"]))
            print("\nUsage:", usage.as_dict())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", "--probe-wikipedia", dest="probe", action="store_true", help="Make one live public, read-only Wikipedia API request")
    parser.add_argument("--probe-google", action="store_true", help="Make one live Google search through MCP (uses SerpAPI search quota; no OpenAI call)")
    parser.add_argument("--question", default="", help="Run an agent question using the configured API key (billed by the provider)")
    parser.add_argument("--model", default=plans.PLANS["free"].chat_model, choices=[model["id"] for model in plans.model_options(plans.PLANS["pro"])])
    try:
        raise SystemExit(asyncio.run(check(parser.parse_args())) or 0)
    except Exception as exc:
        # No raw exception strings: provider and HTTP errors can contain secret-bearing URLs.
        print(f"Check failed ({type(exc).__name__}). Check /api/agent/status and the configured service credentials.", file=sys.stderr)
        raise SystemExit(1)
