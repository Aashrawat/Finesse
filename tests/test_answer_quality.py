"""Completion budgets and conversation context for fuller answers; model calls are mocked."""

import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from core.kb import attachments, chat, config, imagegen, memory, plans
from core.kb.attachments import Attachment, Upload

SESSION = "a" * 32


class CompletionBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_budget_and_model_appropriate_options_reach_plain_and_attachment_requests(self):
        advanced = next(model for model in plans.PRO_MODELS if model != plans.PLANS["free"].chat_model)
        for model, plan in [(plans.PLANS["free"].chat_model, plans.PLANS["free"]), (advanced, plans.PLANS["pro"])]:
            for attached in (False, True):
                with self.subTest(model=model, attached=attached), ExitStack() as stack:
                    stack.enter_context(patch("core.agent.settings.enabled", return_value=False))
                    conv = memory.new_conversation(SESSION, "Explain a concept")
                    answer = "Here is a complete explanation with a practical example. " * 50

                    async def tokens():
                        for offset in range(0, len(answer), 40):
                            yield SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=answer[offset:offset + 40]))])

                    complete = AsyncMock(return_value=tokens())
                    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete)))
                    stack.enter_context(patch.object(chat, "async_client", return_value=client))
                    stack.enter_context(patch.object(config, "IMAGES_ENABLED", False))
                    stack.enter_context(patch.object(config, "MAX_COMPLETION_TOKENS", 8192))
                    stack.enter_context(patch.object(config, "REASONING_EFFORT", "medium"))
                    stack.enter_context(patch.object(chat, "_save_turn"))
                    stack.enter_context(patch.object(chat, "_charge"))
                    stack.enter_context(patch.object(chat, "log_request"))
                    if attached:
                        document = Attachment("1" * 12, "brief.txt", "document", "text/plain", 10, pages=[(0, "This file explains the protocol.")])
                        stack.enter_context(patch.object(attachments, "read_upload", return_value=document))
                        stack.enter_context(patch.object(attachments, "save", return_value=False))
                        stack.enter_context(patch.object(attachments, "document_context", new_callable=AsyncMock, return_value=("This file explains the protocol.", [])))
                    events = [event async for event in chat.stream_chat(
                        conv, "Explain the protocol with an example.",
                        [Upload("brief.txt", b"data")] if attached else [], plan=plan, model=model,
                    )]
                    self.assertTrue(any(event.startswith("event: done") for event in events))
                    request = complete.await_args.kwargs
                    self.assertEqual(request["max_completion_tokens"], 8192)
                    self.assertNotIn("max_tokens", request)
                    if model.startswith(("gpt-4", "gpt-3")):
                        self.assertIn("temperature", request)
                        self.assertNotIn("reasoning_effort", request)
                    else:
                        self.assertEqual(request["reasoning_effort"], "medium")
                        self.assertNotIn("temperature", request)
                    # The whole answer streams through, including well past the old short-answer examples.
                    import json
                    text = "".join(json.loads(event.split("data: ")[1])["t"] for event in events if event.startswith("event: token"))
                    self.assertEqual(text, answer)

    async def test_image_generation_does_not_replace_the_selected_chat_model(self):
        plan = plans.PLANS["pro"]
        conv = memory.new_conversation(SESSION, "A drawing")
        art = SimpleNamespace(prompt="A watercolor garden", shape="square")

        async def wait_for_image(task):
            await task
            if False:
                yield ""

        with (
            patch.object(config, "IMAGES_ENABLED", True),
            patch.object(imagegen, "looks_like_request", return_value=True),
            patch.object(imagegen, "plan", new_callable=AsyncMock, return_value=art),
            patch.object(imagegen, "allow", return_value=True),
            patch.object(imagegen, "generate", new_callable=AsyncMock, return_value=(b"image", "gpt-image-2")),
            patch.object(imagegen, "keep_alive", side_effect=wait_for_image),
            patch.object(attachments, "save_generated", return_value="2" * 12),
            patch.object(chat, "_save_turn") as save,
            patch.object(chat, "_charge"),
            patch.object(chat, "log_request"),
        ):
            events = [event async for event in chat.stream_chat(conv, "Create a watercolor of a garden.", plan=plan)]
        self.assertTrue(any(event.startswith("event: done") for event in events))
        self.assertEqual(save.call_args.kwargs["model"], plan.chat_model)
        self.assertEqual(save.call_args.args[6][0]["model"], "gpt-image-2")


class ConversationDepthTests(unittest.TestCase):
    def test_long_recent_explanation_stays_available_for_a_followup(self):
        conv = memory.new_conversation(SESSION, "Long explanation")
        conv["messages"] = [
            {"role": "user", "content": "Explain the protocol with a Python example."},
            {"role": "assistant", "content": "Detailed explanation and code. " * 250},
        ]
        with patch.object(memory, "count_tokens", side_effect=len):
            history = memory.recent_history(conv, plans.PLANS["free"])
        self.assertEqual(history, conv["messages"])

    def test_previous_smaller_summary_window_does_not_hide_the_current_plans_history(self):
        conv = memory.new_conversation(SESSION, "Upgraded conversation")
        conv["messages"] = [
            {"role": role, "content": f"Turn {turn}: {role}"}
            for turn in range(8) for role in ("user", "assistant")
        ]
        conv["summarized_upto"] = 12
        with patch.object(memory, "count_tokens", side_effect=len):
            self.assertEqual(memory.recent_messages(conv, plans.PLANS["pro"]), conv["messages"])

    def test_background_compression_uses_pro_history_limits(self):
        conv = memory.new_conversation(SESSION, "Pro history")
        conv["messages"] = [
            {"role": role, "content": f"Turn {turn}: {role}"}
            for turn in range(7) for role in ("user", "assistant")
        ]
        store = Mock()
        store.get.return_value = conv

        def immediate_thread(*, target, args, daemon):
            return SimpleNamespace(start=lambda: target(*args))

        with (
            patch.object(memory, "store", store),
            patch.object(memory, "count_tokens", side_effect=len),
            patch.object(chat, "summarize_history") as summarize,
            patch.object(chat.threading, "Thread", side_effect=immediate_thread),
        ):
            chat._save_turn(conv, "Explain further.", "More detail.", [], False, plan=plans.PLANS["pro"])
        summarize.assert_not_called()
        self.assertEqual(conv["summarized_upto"], 0)
        self.assertEqual(len(conv["messages"]), 16)
        store.save.assert_called_once()
