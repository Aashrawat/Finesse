import asyncio
import copy
import os
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import kb
from core.agent import runner, settings
from core.agent.security import Actor
from core.kb import chat, config, memory

SESSION = "a" * 32


class PrivateConversationApiTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(kb.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.conv = memory.new_conversation(SESSION, "Private business data")
        self.conv.update(private_owner="owner", database_context=True)
        self.conv["messages"] = [{"role": "assistant", "content": "42 customers", "sources": []}]
        context = patch.dict(os.environ, {"MCP_DB_ALLOWED_USER_IDS": "owner", "MCP_DB_ALLOW_ADMINS": "false"})
        context.start()
        self.addCleanup(context.stop)

    def test_owner_can_read_but_logout_other_account_and_revoked_permission_cannot(self):
        for user, expected in [(None, 403), ({"_id": "other"}, 403), ({"_id": "owner"}, 200)]:
            with self.subTest(user=user), patch.object(kb, "current_user", return_value=user), patch.object(memory.store, "get", return_value=self.conv):
                response = self.client.get(f"/api/conversations/{self.conv['id']}", headers={"X-Session-Id": SESSION})
            self.assertEqual(response.status_code, expected)
        with patch.dict(os.environ, {"MCP_DB_ALLOWED_USER_IDS": ""}), patch.object(kb, "current_user", return_value={"_id": "owner"}), patch.object(memory.store, "get", return_value=self.conv):
            response = self.client.get(f"/api/conversations/{self.conv['id']}", headers={"X-Session-Id": SESSION})
        self.assertEqual(response.status_code, 403)

    def test_private_titles_are_filtered_and_internal_owner_metadata_is_not_returned(self):
        private = {key: self.conv[key] for key in ("id", "title", "created_at", "updated_at", "private_owner", "database_context")}
        public = {"id": "b" * 12, "title": "General question", "created_at": "now", "updated_at": "now"}
        for user, count in [(None, 1), ({"_id": "owner"}, 2)]:
            with self.subTest(user=user), patch.object(kb, "current_user", return_value=user), patch.object(memory.store, "list", return_value=[private, public]):
                response = self.client.get("/api/conversations", headers={"X-Session-Id": SESSION})
            self.assertEqual(len(response.json()), count)
            self.assertTrue(all("private_owner" not in item for item in response.json()))

    def test_non_owner_cannot_delete_or_continue_a_private_conversation(self):
        with patch.object(kb, "current_user", return_value=None), patch.object(memory.store, "get", return_value=self.conv), patch.object(memory.store, "delete") as delete:
            response = self.client.delete(f"/api/conversations/{self.conv['id']}", headers={"X-Session-Id": SESSION})
        self.assertEqual(response.status_code, 403)
        delete.assert_not_called()
        with patch.object(kb, "_account", new_callable=AsyncMock, return_value=None), patch.object(kb.guest, "check", return_value=None), patch.object(memory.store, "get", return_value=self.conv), patch.object(kb, "stream_chat") as stream:
            response = self.client.post("/api/chat", data={"message": "Read previous data", "conversation_id": self.conv["id"]}, headers={"X-Session-Id": SESSION})
        self.assertEqual(response.status_code, 403)
        stream.assert_not_called()


class PrivateConversationStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_private_answer_keeps_its_owner_and_database_scope(self):
        async def private_reply(*args):
            yield "private_context", {"private": True, "database": True}
            yield "token", {"t": "Private result: 42."}
            raise asyncio.CancelledError()

        with patch.object(settings, "enabled", return_value=True), patch.object(config, "IMAGES_ENABLED", False), patch.object(runner, "run", side_effect=private_reply), patch.object(chat, "_save_turn") as save, patch.object(chat, "_charge"), patch.object(chat, "log_request"):
            with self.assertRaises(asyncio.CancelledError):
                async for _ in chat.stream_chat(memory.new_conversation(SESSION, "Private"), "Count customers", actor=Actor("owner", database=True)):
                    pass
        self.assertEqual(save.call_args.kwargs["private_owner"], "owner")
        self.assertTrue(save.call_args.kwargs["database_context"])
        self.assertTrue(save.call_args.args[4])
