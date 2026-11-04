"""Chat must stay useful without reading or writing the shared document index.

Run with your virtualenv Python: python -m unittest discover -s tests -v
All model calls are mocked; files live in temporary conversation folders.
"""

import copy
import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import kb
from core.kb import attachments, chat, clients, config, memory, retrieval
from core.kb.attachments import Attachment, Upload
from core.kb.chunking import Chunk

SESSION = "a" * 32


class ChatScopeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        self.patches.enter_context(patch("core.agent.settings.enabled", return_value=False))
        self.patches.enter_context(patch.object(config, "CHATS_DIR", self.temp.name))
        self.patches.enter_context(patch.object(config, "IMAGES_ENABLED", False))
        self.patches.enter_context(patch.object(attachments, "count_tokens", side_effect=len))
        self.patches.enter_context(patch.object(memory, "count_tokens", side_effect=len))
        self.save = self.patches.enter_context(patch.object(chat, "_save_turn"))
        self.patches.enter_context(patch.object(chat, "_charge"))
        self.patches.enter_context(patch.object(chat, "log_request"))
        self.embed = self.patches.enter_context(patch.object(
            retrieval, "embed_query", new_callable=AsyncMock,
            side_effect=AssertionError("General chat must not search an index"),
        ))

        async def tokens():
            yield SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content="Happy to help."))])

        self.complete = AsyncMock(side_effect=lambda **kwargs: tokens())
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=self.complete)))
        self.patches.enter_context(patch.object(chat, "async_client", return_value=client))

    async def turn(self, conv, question, uploads=None):
        raw = [event async for event in chat.stream_chat(conv, question, uploads)]
        return [
            (event.splitlines()[0].removeprefix("event: "), json.loads(event.splitlines()[1].removeprefix("data: ")))
            for event in raw
        ]

    async def test_general_chat_keeps_history_and_has_no_shared_sources(self):
        conv = memory.new_conversation(SESSION, "Writing")
        conv["summary"] = "The user is writing a friendly invitation."
        conv["messages"] = [
            {"role": "user", "content": "I'm planning a dinner."},
            {"role": "assistant", "content": "Who are you inviting?"},
        ]
        with patch.object(chat, "rewrite_query", new_callable=AsyncMock) as rewrite:
            events = await self.turn(conv, "Help me write the invitation.")
        self.assertIn(("token", {"t": "Happy to help."}), events)
        self.assertIn(("sources", {"sources": []}), events)
        self.assertEqual(events[-1][0], "done")
        prompt = self.complete.await_args.kwargs["messages"]
        self.assertIn(conv["messages"][0], prompt)
        self.assertIn(conv["messages"][1], prompt)
        self.assertIn(conv["summary"], prompt[1]["content"])
        self.assertNotIn("knowledge base", json.dumps(prompt).lower())
        self.embed.assert_not_awaited()
        rewrite.assert_not_awaited()
        self.save.assert_called_once()
        self.assertEqual(self.save.call_args.args[3], [])

    async def test_uploaded_document_is_read_and_saved_only_with_its_conversation(self):
        conv = memory.new_conversation(SESSION, "A brief")
        events = await self.turn(conv, "Summarize this.", [Upload("brief.txt", b"This project is about a neighborhood garden.")])
        self.assertEqual(events[-1][0], "done")
        self.assertIn("neighborhood garden", json.dumps(self.complete.await_args.kwargs["messages"]))
        files = self.save.call_args.args[5]
        saved = Path(self.temp.name) / SESSION / conv["id"] / f"{files[0].id}.doc.json"
        self.assertTrue(saved.is_file())
        self.assertEqual(list(Path(self.temp.name).rglob("*.doc.json")), [saved])
        self.embed.assert_not_awaited()

    async def test_followup_reads_only_this_conversations_document(self):
        conv = memory.new_conversation(SESSION, "Current chat")
        other = memory.new_conversation("b" * 32, "Other chat")
        own = Attachment("1" * 12, "own.txt", "document", "text/plain", 10, pages=[(0, "Our garden has apple trees.")])
        private = Attachment("2" * 12, "private.txt", "document", "text/plain", 10, pages=[(0, "Unrelated private document.")])
        for target, document in [(conv, own), (other, private)]:
            attachments.save(target["session_id"], target["id"], [document])
            target["messages"] = [{"role": "user", "content": "Read this.", "attachments": [document.meta()]}]
        with patch.object(chat, "rewrite_query", new_callable=AsyncMock, return_value="What trees are in the garden?"):
            events = await self.turn(conv, "What trees does it have?")
        self.assertEqual(events[-1][0], "done")
        prompt = json.dumps(self.complete.await_args.kwargs["messages"])
        self.assertIn("apple trees", prompt)
        self.assertNotIn("Unrelated private document", prompt)

    async def test_new_document_replaces_earlier_document_context(self):
        conv = memory.new_conversation(SESSION, "Two uploads")
        old = Attachment("3" * 12, "old.txt", "document", "text/plain", 10, pages=[(0, "OLD DOCUMENT CONTENT")])
        attachments.save(SESSION, conv["id"], [old])
        conv["messages"] = [{"role": "user", "content": "Read this.", "attachments": [old.meta()]}]
        events = await self.turn(conv, "Summarize this.", [Upload("new.txt", b"NEW DOCUMENT CONTENT")])
        self.assertEqual(events[-1][0], "done")
        prompt = json.dumps(self.complete.await_args.kwargs["messages"])
        self.assertIn("NEW DOCUMENT CONTENT", prompt)
        self.assertNotIn("OLD DOCUMENT CONTENT", prompt)

    async def test_large_attachment_uses_conversation_cache_without_loading_shared_store(self):
        conv = memory.new_conversation(SESSION, "Long document")
        document = Attachment("4" * 12, "long.txt", "document", "text/plain", 10, pages=[(1, "The garden needs watering.")])
        client = Mock()
        client.embeddings.create.return_value = SimpleNamespace(data=[SimpleNamespace(index=0, embedding=[1.0, 0.0])])
        with (
            patch.object(config, "ATTACH_FULL_TOKENS", 0),
            patch.object(attachments, "embed_query", new_callable=AsyncMock, return_value=[1.0, 0.0]),
            patch.object(attachments, "chunk_pages", return_value=[Chunk(document.pages[0][1], 1, 1, 5)]),
            patch.object(clients, "sync_client", return_value=client),
        ):
            attachments.save(SESSION, conv["id"], [document])
            context, sources = await attachments.document_context(conv, [document], "What does the garden need?", retrieval.Usage())
            self.assertIn("needs watering", context)
            self.assertEqual(sources[0]["chunk_id"], f"{document.id}::0")
            cache = Path(self.temp.name) / SESSION / conv["id"] / f"{document.id}.vec.json"
            self.assertTrue(cache.is_file())
            await attachments.document_context(conv, [document], "And now?", retrieval.Usage())
            client.embeddings.create.assert_called_once()
        self.assertNotIn("core.kb.store", sys.modules)


class ChatApiScopeTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(kb.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_ingestion_is_disabled_even_when_forced(self):
        response = self.client.post("/api/ingest", json={"force": True}, headers={"X-Session-Id": SESSION})
        self.assertEqual(response.status_code, 410)
        self.assertIn("disabled", response.json()["detail"])
        self.assertNotIn("core.kb.store", sys.modules)

    def test_documents_does_not_expose_or_open_existing_index(self):
        response = self.client.get("/api/documents")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["enabled"])
        self.assertEqual(response.json()["documents"], [])
        self.assertEqual(response.json()["total_chunks"], 0)
        self.assertNotIn("core.kb.store", sys.modules)

    def test_old_shared_sources_are_removed_but_attachment_sources_and_history_remain(self):
        conv = memory.new_conversation(SESSION, "Existing chat")
        source = {"source": "own.txt", "chunk_id": "555555555555::0"}
        shared = {"source": "someone-elses.pdf", "chunk_id": "someone-elses.pdf::0"}
        unrelated = {"source": "another-chat.txt", "chunk_id": "666666666666::0"}
        conv["messages"] = [
            {"role": "assistant", "content": "An old reply.", "sources": [shared, source]},
            {"role": "user", "content": "Read this.", "attachments": [{"id": "5" * 12, "name": "own.txt", "kind": "document"}]},
            {"role": "assistant", "content": "Your document says…", "sources": [source, shared, unrelated]},
        ]
        original = copy.deepcopy(conv)
        with patch.object(memory.store, "get", return_value=conv):
            response = self.client.get(f"/api/conversations/{conv['id']}", headers={"X-Session-Id": SESSION})
        self.assertEqual(response.status_code, 200)
        messages = response.json()["messages"]
        self.assertEqual(messages[0]["sources"], [])
        self.assertEqual(messages[2]["sources"], [source])
        self.assertEqual([m["content"] for m in messages], [m["content"] for m in original["messages"]])
        self.assertEqual(conv, original, "Reading must not rewrite stored chat history")
