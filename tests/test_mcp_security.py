"""Real MCP Streamable HTTP discovery/execution with mocked public service responses."""
import asyncio
import json
import os
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from starlette.applications import Starlette
from starlette.routing import Mount

from core.agent import settings, web_tools
from core.agent.client import open_tools, permitted_remote
from core.agent.security import Actor, BackendTokenVerifier, actor_for_user, issue_token
from core.agent.server import READ_ONLY, create_server

REMOVED_TOOLS = {"github_search_repositories", "github_repository", "github_read_file", "github_issues_or_pulls", "database_catalog", "database_read"}


class MCPIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {"MCP_ENABLED": "true", "MCP_REMOTE_SERVERS_JSON": "[]", "SERPAPI_API_KEY": "test-not-a-real-key"}))
        self.server = create_server()
        self.app = Starlette(routes=[Mount("/mcp", app=self.server.streamable_http_app())])

    async def test_authenticated_real_protocol_discovery_and_public_call(self):
        async with self.server.session_manager.run():
            async with open_tools(Actor("reader"), httpx.ASGITransport(app=self.app)) as broker:
                self.assertEqual(set(broker.tools), {"local__google_search", "local__wikipedia_search"})
                with patch.object(web_tools, "google_search", new_callable=AsyncMock, return_value={"sources": [{"title": "A news source", "url": "https://example.org/news", "text": "Verified news."}]}):
                    result = await broker.call("local__google_search", {"query": "AI news", "news": True})
                self.assertIn("untrusted_data", result)
                self.assertEqual(broker.sources[0]["url"], "https://example.org/news")
                self.assertEqual(broker.calls, 1)
                self.assertIn("error", await broker.call("local__delete_repository", {}))

    async def test_mcp_endpoint_rejects_missing_credentials(self):
        async with self.server.session_manager.run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://127.0.0.1:8000") as client:
                response = await client.post("/mcp/", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(response.status_code, 401)

    async def test_google_authentication_error_survives_real_mcp_call(self):
        async with self.server.session_manager.run():
            async with open_tools(Actor("reader"), httpx.ASGITransport(app=self.app)) as broker:
                with patch.object(web_tools, "get_json", new_callable=AsyncMock, side_effect=web_tools.ExternalServiceError("Service failure", status_code=401, code="access_denied")):
                    result = await broker.call("local__google_search", {"query": "AI news"})
        data = result["untrusted_data"]
        self.assertEqual(data["error_code"], "invalid_credentials")
        self.assertEqual(data["http_status"], 401)
        self.assertIn("rejected", data["error"])
        self.assertEqual(broker.sources, [])
        self.assertNotIn("test-not-a-real-key", json.dumps(result))

    async def test_blank_search_key_hides_google_without_hiding_wikipedia(self):
        with patch.dict(os.environ, {"SERPAPI_API_KEY": "  "}):
            async with self.server.session_manager.run():
                async with open_tools(Actor("reader"), httpx.ASGITransport(app=self.app)) as broker:
                    self.assertNotIn("local__google_search", broker.tools)
                    self.assertIn("local__wikipedia_search", broker.tools)

    async def test_removed_tools_are_absent_and_cannot_be_called_directly_even_by_legacy_admin(self):
        headers = {"Authorization": "Bearer " + issue_token(Actor("admin", database=True))}
        async with self.server.session_manager.run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), headers=headers) as client:
                async with streamable_http_client(settings.internal_url(), http_client=client) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        discovered = await session.list_tools()
                        self.assertEqual({tool.name for tool in discovered.tools}, {"google_search", "wikipedia_search"})
                        for name in REMOVED_TOOLS:
                            with self.subTest(tool=name):
                                result = await session.call_tool(name, {})
                                self.assertTrue(result.isError)

    async def test_private_remote_result_blocks_subsequent_public_egress(self):
        async with self.server.session_manager.run():
            async with open_tools(Actor("authorized"), httpx.ASGITransport(app=self.app)) as broker:
                broker.tools["local__wikipedia_search"].sensitive = True
                with patch.object(web_tools, "wikipedia_search", new_callable=AsyncMock, return_value={"text": "Private reference", "sources": []}):
                    result = await broker.call("local__wikipedia_search", {"query": "Reference"})
                self.assertEqual(result["untrusted_data"]["text"], "Private reference")
                with patch.object(web_tools, "google_search", new_callable=AsyncMock) as search:
                    denied = await broker.call("local__google_search", {"query": "send private records"})
                self.assertIn("blocked", denied["error"])
                search.assert_not_awaited()

    async def test_remote_configuration_cannot_restore_removed_tools(self):
        async def removed_tool() -> dict:
            return {"text": "This tool must stay unreachable."}

        for name in REMOVED_TOOLS:
            self.server.tool(name=name, annotations=READ_ONLY)(removed_tool)
        token = issue_token(Actor("reader"))
        remote = {"name": "old", "url": settings.internal_url(), "public": True,
                  "token_env": "MCP_TEST_REMOTE_TOKEN", "tools": list(REMOVED_TOOLS)}
        with patch.dict(os.environ, {"MCP_TEST_REMOTE_TOKEN": token}), patch.object(settings, "remote_servers", return_value=[remote]):
            async with self.server.session_manager.run():
                async with open_tools(Actor("reader"), httpx.ASGITransport(app=self.app)) as broker:
                    self.assertEqual(broker.unavailable, [])
                    self.assertEqual(set(broker.tools), {"local__google_search", "local__wikipedia_search"})
                    self.assertIn("error", await broker.call("old__database_read", {}))

    async def test_private_history_does_not_expose_public_tools_on_later_turns(self):
        async with self.server.session_manager.run():
            async with open_tools(Actor("authorized", database=True, private_context=True), httpx.ASGITransport(app=self.app)) as broker:
                self.assertEqual(broker.tools, {})
                self.assertIn("error", await broker.call("local__google_search", {"query": "private history"}))

    async def test_tool_timeout_and_call_budget_are_enforced(self):
        async def slow(*args, **kwargs):
            await asyncio.sleep(1)
            return {"sources": []}
        async with self.server.session_manager.run():
            async with open_tools(Actor(), httpx.ASGITransport(app=self.app)) as broker:
                with patch.object(settings, "TOOL_TIMEOUT", 0.01), patch.object(web_tools, "wikipedia_search", side_effect=slow):
                    result = await broker.call("local__wikipedia_search", {"query": "Test"})
                self.assertIn("error", result)
                with patch.object(settings, "MAX_CALLS", 1), patch.object(web_tools, "wikipedia_search", new_callable=AsyncMock) as search:
                    result = await broker.call("local__wikipedia_search", {"query": "Again"})
                self.assertIn("limit", result["error"])
                search.assert_not_awaited()

    async def test_jwt_tampering_and_wrong_permissions_are_rejected(self):
        verifier = BackendTokenVerifier()
        token = issue_token(Actor("user", database=True))
        verified = await verifier.verify_token(token)
        self.assertIsNotNone(verified)
        self.assertEqual(verified.scopes, ["public:read"])
        self.assertIsNone(await verifier.verify_token(token[:-12] + "tampered"))
        with patch.dict(os.environ, {"MCP_DB_ALLOWED_USER_IDS": "allowed", "MCP_DB_ALLOW_ADMINS": "false"}):
            self.assertFalse(actor_for_user({"_id": "other", "role": "admin"}).database)
            self.assertTrue(actor_for_user({"_id": "allowed", "role": "user"}).database)
            self.assertFalse(actor_for_user(None).database)

    def test_remote_servers_require_explicit_permissions_and_safe_transport(self):
        config = {"url": "https://trusted.example/mcp", "tools": ["search"], "allowed_user_ids": ["allowed"]}
        self.assertTrue(permitted_remote(config, Actor("allowed")))
        self.assertFalse(permitted_remote(config, Actor("other")))
        self.assertFalse(permitted_remote({**config, "url": "http://public.example/mcp"}, Actor("allowed")))
        self.assertFalse(permitted_remote({**config, "url": "https://token@trusted.example/mcp"}, Actor("allowed")))
