import json
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from core.agent import web_tools


class WebToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_google_uses_serpapi_and_does_not_return_its_key(self):
        data = {"organic_results": [{"title": "News", "link": "https://example.org/news", "snippet": "A report."}]}
        with patch.dict(os.environ, {"SERPAPI_API_KEY": "test-secret"}), patch.object(web_tools, "get_json", new_callable=AsyncMock, return_value=data) as get:
            result = await web_tools.google_search("AI news")
        self.assertEqual(get.call_args.args[0], "https://serpapi.com/search.json")
        self.assertEqual(get.call_args.kwargs["params"]["engine"], "google")
        self.assertEqual(get.call_args.kwargs["params"]["api_key"], "test-secret")
        self.assertNotIn("test-secret", json.dumps(result))
        self.assertEqual(result["sources"][0]["url"], "https://example.org/news")

    async def test_google_missing_key_does_not_make_a_request(self):
        with patch.dict(os.environ, {"SERPAPI_API_KEY": "  "}), patch.object(web_tools, "get_json", new_callable=AsyncMock) as get:
            result = await web_tools.google_search("AI news")
        self.assertEqual(result["error_code"], "not_configured")
        self.assertEqual(result["sources"], [])
        get.assert_not_awaited()

    async def test_google_reports_provider_failures_without_calling_them_missing_tools(self):
        failures = [
            (401, "access_denied", "invalid_credentials"),
            (403, "access_denied", "access_denied"),
            (429, "rate_limited", "rate_limited"),
            (503, "service_unavailable", "service_unavailable"),
            (None, "timeout", "timeout"),
        ]
        for status, service_code, expected_code in failures:
            with self.subTest(status=status), patch.dict(os.environ, {"SERPAPI_API_KEY": "test-secret"}), patch.object(web_tools, "get_json", new_callable=AsyncMock, side_effect=web_tools.ExternalServiceError("Service failure", status_code=status, code=service_code)):
                result = await web_tools.google_search("AI news")
            self.assertEqual(result["error_code"], expected_code)
            self.assertEqual(result["http_status"], status)
            self.assertEqual(result["sources"], [])
            self.assertNotIn("test-secret", json.dumps(result))
            if status == 401:
                self.assertIn("rejected", result["error"])
                self.assertIn("SERPAPI_API_KEY", result["error"])
            if status == 429:
                self.assertIn("quota", result["error"])

    async def test_google_error_payload_does_not_leak_upstream_details_or_claim_verification(self):
        payloads = [{"error": "Invalid key test-secret"}, {"search_metadata": {"status": "Error"}}, []]
        for data in payloads:
            with self.subTest(data=data), patch.dict(os.environ, {"SERPAPI_API_KEY": "test-secret"}), patch.object(web_tools, "get_json", new_callable=AsyncMock, return_value=data):
                result = await web_tools.google_search("AI news")
            self.assertEqual(result["error_code"], "search_failed")
            self.assertEqual(result["sources"], [])
            self.assertNotIn("test-secret", json.dumps(result))

    async def test_wikipedia_uses_public_api_and_returns_source_links(self):
        data = {"query": {"pages": {"1": {"title": "Albert Einstein", "extract": "A physicist.", "fullurl": "https://en.wikipedia.org/wiki/Albert_Einstein", "index": 1}}}}
        with patch.object(web_tools, "get_json", new_callable=AsyncMock, return_value=data) as get:
            result = await web_tools.wikipedia_search("Albert Einstein")
        self.assertEqual(get.call_args.args[0], "https://en.wikipedia.org/w/api.php")
        self.assertEqual(result["sources"][0]["text"], "A physicist.")

    async def test_wikipedia_request_includes_identifiable_bot_and_contact_information(self):
        response_data = {"query": {"pages": {"1": {"title": "Cristiano Ronaldo", "extract": "A Portuguese footballer.", "fullurl": "https://en.wikipedia.org/wiki/Cristiano_Ronaldo"}}}}

        def request_handler(request):
            agent = request.headers["User-Agent"]
            if "FinesseBot/" not in agent or "https://" not in agent:
                return httpx.Response(403, text="Please respect our robot policy")
            return httpx.Response(200, json=response_data)

        client_class = httpx.AsyncClient
        def client(**kwargs):
            return client_class(transport=httpx.MockTransport(request_handler), **kwargs)

        with patch.dict(os.environ, {"WIKIMEDIA_USER_AGENT": "", "APP_URL": "http://localhost:5173"}), patch.object(web_tools.httpx, "AsyncClient", side_effect=client):
            result = await web_tools.wikipedia_search("Cristiano Ronaldo")
        self.assertEqual(result["sources"][0]["title"], "Cristiano Ronaldo")

    async def test_wikipedia_operator_can_configure_its_user_agent(self):
        agent = "FinesseBot/1.0 (https://example.org/contact)"
        with patch.dict(os.environ, {"WIKIMEDIA_USER_AGENT": agent}), patch.object(web_tools, "get_json", new_callable=AsyncMock, return_value={}) as get:
            await web_tools.wikipedia_search("Cristiano Ronaldo")
        self.assertEqual(get.call_args.kwargs["headers"]["User-Agent"], agent)

    async def test_wikipedia_denial_and_rate_limit_are_not_misreported_as_empty_searches(self):
        for status, code in [(403, "access_denied"), (429, "rate_limited")]:
            with self.subTest(status=status), patch.object(web_tools, "get_json", new_callable=AsyncMock, side_effect=web_tools.ExternalServiceError("Service failure", status_code=status, code=code)):
                result = await web_tools.wikipedia_search("Cristiano Ronaldo")
            self.assertEqual(result["http_status"], status)
            self.assertEqual(result["error_code"], code)
            self.assertEqual(result["sources"], [])
            self.assertIn(str(status), result["error"])

    async def test_http_errors_preserve_status_without_leaking_keys_or_response_bodies(self):
        client_class = httpx.AsyncClient
        def client(**kwargs):
            return client_class(transport=httpx.MockTransport(lambda request: httpx.Response(403, text="private upstream details")), **kwargs)
        with patch.object(web_tools.httpx, "AsyncClient", side_effect=client):
            with self.assertRaises(web_tools.ExternalServiceError) as error:
                await web_tools.get_json("https://serpapi.com/search.json", params={"api_key": "test-secret"})
        self.assertEqual(error.exception.status_code, 403)
        self.assertNotIn("test-secret", str(error.exception))
        self.assertNotIn("private upstream details", str(error.exception))

    async def test_wikipedia_api_errors_do_not_claim_verification(self):
        with patch.object(web_tools, "get_json", new_callable=AsyncMock, return_value={"error": {"code": "badrequest"}}):
            result = await web_tools.wikipedia_search("Cristiano Ronaldo")
        self.assertEqual(result["error_code"], "api_error")
        self.assertEqual(result["sources"], [])

    def test_source_urls_reject_executable_schemes_and_credentials(self):
        self.assertEqual(web_tools.safe_url("javascript:alert(1)"), "")
        self.assertEqual(web_tools.safe_url("https://user:secret@example.org"), "")
