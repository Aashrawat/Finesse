"""Pro model selection and retirement of the Premium tier. No paid API calls or database writes."""

import copy
import json
import unittest
from contextlib import ExitStack
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import kb, plans as plan_api
from core.auth import service as auth
from core.billing import service as billing
from core.kb import chat, config, memory, plans

SESSION = "a" * 32
PRO_MODEL = next(model for model in plans.PRO_MODELS if model != plans.PLANS["free"].chat_model)


class PlanModelTests(unittest.TestCase):
    def test_only_free_and_pro_are_offered(self):
        self.assertEqual(plans.ORDER, ("free", "pro"))
        self.assertEqual(set(plans.PLANS), {"free", "pro"})
        app = FastAPI()
        app.include_router(plan_api.router)
        with patch.object(plan_api, "current_user", return_value=None), patch.object(billing, "enabled", return_value=False), TestClient(app) as client:
            response = client.get("/api/plans")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([plan["id"] for plan in response.json()["plans"]], ["free", "pro"])

    def test_free_models_are_locked_and_pro_can_select_each_allowed_model(self):
        free = plans.PLANS["free"]
        pro = plans.PLANS["pro"]
        for model in plans.model_options(free):
            with self.subTest(model=model["id"]):
                if model["pro_only"]:
                    self.assertFalse(model["available"])
                    with self.assertRaises(plans.ModelSelectionError) as error:
                        plans.select_model(free, model["id"])
                    self.assertEqual(error.exception.status, 403)
                else:
                    self.assertEqual(plans.select_model(free, model["id"]), free.chat_model)
        for model in plans.model_options(pro):
            self.assertTrue(model["available"])
            self.assertEqual(plans.select_model(pro, model["id"]), model["id"])
        self.assertEqual(plans.select_model(pro), pro.chat_model)
        with self.assertRaises(plans.ModelSelectionError) as error:
            plans.select_model(pro, "unconfigured-expensive-model")
        self.assertEqual(error.exception.status, 422)

    def test_legacy_premium_accounts_receive_pro_without_rewriting_the_account(self):
        doc = {"_id": "existing", "name": "Test", "email": "person@example.test", "plan": "premium", "created_at": datetime.now(timezone.utc)}
        original = copy.deepcopy(doc)
        self.assertEqual(plans.for_user(doc).id, "pro")
        self.assertEqual(auth.public_user(doc)["plan"], "pro")
        self.assertEqual(doc, original)
        self.assertTrue(plans.for_user(doc).research)

    def test_admins_receive_pro(self):
        doc = {"_id": "admin", "email": "admin@example.test", "role": "admin", "plan": "premium"}
        with patch.object(auth, "get_db") as database:
            result = auth.apply_admin(doc)
        self.assertEqual(result["plan"], "pro")
        database.return_value.users.update_one.assert_called_once_with({"_id": "admin"}, {"$set": {"plan": "pro"}})

    def test_billing_requires_only_pro_price_and_rejects_new_premium_checkout(self):
        values = {"STRIPE_SECRET_KEY": "test-key", "STRIPE_PRICE_PRO": "price_pro", "STRIPE_PRICE_PREMIUM": "price_legacy"}
        with patch.object(billing, "_env", side_effect=lambda name: values.get(name, "")):
            self.assertTrue(billing.enabled())
            self.assertEqual(billing.price_ids(), {"pro": "price_pro"})
            self.assertEqual(billing.plan_for_price("price_legacy"), "pro")
            with self.assertRaises(billing.BillingError):
                billing.checkout({}, "premium")

    def test_legacy_subscription_webhook_keeps_pro_without_a_false_plan_change(self):
        user = {"_id": "old", "name": "Test", "plan": "premium"}
        subscription = {"id": "sub_old", "customer": "customer_old", "status": "active", "items": {"data": [{"price": {"id": "legacy_price"}}]}}
        with (
            patch.object(billing, "_find_user", return_value=user),
            patch.object(billing, "plan_for_price", return_value="pro"),
            patch.object(billing, "_set", return_value={**user, "plan": "pro"}) as update,
            patch.object(billing, "_email") as email,
        ):
            billing._on_subscription(subscription, {}, "event_test")
        self.assertEqual(update.call_args.kwargs["plan"], "pro")
        email.assert_not_called()


class ModelApiTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(kb.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.account = self.stack.enter_context(patch.object(kb, "_account", new_callable=AsyncMock))
        self.stack.enter_context(patch.object(plans, "message_block", return_value=None))
        self.stack.enter_context(patch.object(kb.guest, "check", return_value=None))
        self.stream = self.stack.enter_context(patch.object(kb, "stream_chat"))

        async def answer(*args, **kwargs):
            yield chat.sse("meta", {"conversation_id": args[0]["id"], "title": "Test", "model": kwargs["model"]})
            yield chat.sse("token", {"t": "A response."})
        self.stream.side_effect = answer

    def post(self, model=None):
        data = {"message": "Explain a concept."}
        if model is not None:
            data["model"] = model
        return self.client.post("/api/chat", data=data, headers={"X-Session-Id": SESSION})

    def test_guests_and_free_cannot_bypass_the_picker_with_a_forged_request(self):
        for user in [None, {"_id": "free", "plan": "free"}]:
            with self.subTest(user=user), patch.object(kb, "_read_files", new_callable=AsyncMock) as read:
                self.account.return_value = user
                response = self.post(PRO_MODEL)
                self.assertEqual(response.status_code, 403)
                self.assertIn("Pro", response.json()["detail"])
                read.assert_not_awaited()
        self.stream.assert_not_called()

    def test_pro_model_is_forwarded_and_unknown_models_are_rejected(self):
        self.account.return_value = {"_id": "paid", "plan": "pro"}
        response = self.post(PRO_MODEL)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.stream.call_args.kwargs["model"], PRO_MODEL)
        self.assertIn(PRO_MODEL, response.text)
        response = self.post("unconfigured-expensive-model")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.stream.call_count, 1)

    def test_omitting_model_preserves_plan_default_and_legacy_accounts_keep_access(self):
        for plan in ["free", "pro", "premium"]:
            with self.subTest(plan=plan):
                self.account.return_value = {"_id": "test", "plan": plan}
                response = self.post()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(self.stream.call_args.kwargs["model"], plans.get(plan).chat_model)

    def test_guest_quota_lists_locked_pro_options(self):
        self.account.return_value = None
        with patch.object(kb.guest, "status", return_value={"blocked": False}):
            response = self.client.get("/api/chat/quota", headers={"X-Session-Id": SESSION})
        data = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(data["guest"])
        self.assertEqual(data["model"], plans.PLANS["free"].chat_model)
        self.assertTrue(any(model["pro_only"] and not model["available"] for model in data["models"]))


class SelectedModelStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_model_reaches_the_provider_and_saved_reply(self):
        conv = memory.new_conversation(SESSION, "Models")

        async def tokens():
            yield SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content="A smart answer."))])

        complete = AsyncMock(return_value=tokens())
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete)))
        with (
            patch.object(chat, "async_client", return_value=client),
            patch("core.agent.settings.enabled", return_value=False),
            patch.object(config, "IMAGES_ENABLED", False),
            patch.object(chat, "_save_turn") as save,
            patch.object(chat, "_charge"),
            patch.object(chat, "log_request"),
        ):
            events = [event async for event in chat.stream_chat(conv, "Explain recursion.", plan=plans.PLANS["pro"], model=PRO_MODEL)]
        self.assertTrue(any(event.startswith("event: done") for event in events))
        self.assertEqual(complete.await_args.kwargs["model"], PRO_MODEL)
        self.assertNotIn("temperature", complete.await_args.kwargs)
        self.assertEqual(save.call_args.kwargs["model"], PRO_MODEL)
        self.assertIn(PRO_MODEL, json.loads(events[0].split("data: ")[1])["model"])
