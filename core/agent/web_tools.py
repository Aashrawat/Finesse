"""Public, read-only service adapters. No model-supplied URL is ever fetched."""
import os
import logging
from urllib.parse import urlparse

import httpx

from core.agent import settings

# httpx's INFO request log contains full query strings, including SerpAPI's API key.
# Audit tool names and timings in client.py instead of logging credential-bearing URLs.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger("finesse.agent.web")


class ExternalServiceError(ValueError):
    """A safe service failure: no request URLs, credentials or upstream response bodies."""
    def __init__(self, message: str, *, status_code: int | None = None, code: str = "service_unavailable"):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def wikimedia_headers() -> dict[str, str]:
    """Wikimedia requires an identifiable client with operator contact information."""
    custom = os.getenv("WIKIMEDIA_USER_AGENT", "").strip()
    contact = safe_url(os.getenv("APP_URL", ""))
    if not contact or urlparse(contact).hostname in {"localhost", "127.0.0.1", "::1"}:
        contact = "https://github.com/Aashrawat/Finesse"
    agent = custom or f"FinesseBot/1.0 ({contact}) httpx/{httpx.__version__}"
    return {"User-Agent": agent}


def safe_url(value: str) -> str:
    parsed = urlparse(value)
    return value if parsed.scheme in {"http", "https"} and parsed.hostname and parsed.username is None and parsed.password is None else ""


async def get_json(url: str, *, params: dict | None = None, headers: dict | None = None):
    try:
        async with httpx.AsyncClient(timeout=settings.TOOL_TIMEOUT, follow_redirects=False, trust_env=False) as client:
            response = await client.get(url, params=params, headers={"User-Agent": "Finesse-MCP/1.0", **(headers or {})})
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        code = "access_denied" if status in {401, 403} else "rate_limited" if status == 429 else "service_unavailable"
        logger.warning("external_service_failed host=%s status=%s", urlparse(url).hostname, status)
        raise ExternalServiceError(f"The external service returned HTTP {status}.", status_code=status, code=code) from None
    except httpx.TimeoutException:
        raise ExternalServiceError("The external service timed out.", code="timeout") from None
    except httpx.HTTPError:
        raise ExternalServiceError("The external service could not be reached.", code="network_error") from None
    except ValueError:
        raise ExternalServiceError("The external service returned an unreadable response.", code="invalid_response") from None


async def google_search(query: str, limit: int = 5, news: bool = False) -> dict:
    key = os.getenv("SERPAPI_API_KEY", "").strip()
    if not key:
        return {"error": "Google Search is not configured (SERPAPI_API_KEY is missing).", "error_code": "not_configured", "sources": []}
    if not query.strip() or len(query) > 500:
        raise ValueError("Search queries must contain 1–500 characters.")
    params = {"engine": "google", "q": query, "api_key": key, "num": max(1, min(8, limit)), "hl": "en"}
    if news:
        params["tbm"] = "nws"
    try:
        data = await get_json("https://serpapi.com/search.json", params=params)
    except ExternalServiceError as exc:
        code = exc.code
        if exc.status_code == 401:
            code = "invalid_credentials"
            message = "Google Search is configured, but SerpAPI rejected the server's API key (HTTP 401). The app owner must update SERPAPI_API_KEY and restart the backend."
        elif exc.status_code == 403:
            message = "Google Search is configured, but SerpAPI denied this server access (HTTP 403). The app owner must check the search account's permissions."
        elif exc.status_code == 429:
            message = "Google Search reached SerpAPI's rate limit or search quota (HTTP 429). The app owner must check the account's available searches and limits."
        else:
            message = f"Google Search is temporarily unavailable: {exc}"
        return {"error": message, "error_code": code, "http_status": exc.status_code, "sources": []}
    if not isinstance(data, dict) or data.get("error") or data.get("search_metadata", {}).get("status") == "Error":
        # Upstream error text can contain credentials. Return only our own diagnostic.
        return {"error": "SerpAPI could not complete the Google search. No facts were verified.", "error_code": "search_failed", "sources": []}
    results = data.get("news_results" if news else "organic_results", [])[:max(1, min(8, limit))]
    sources = [{"title": item.get("title", "Search result"), "url": safe_url(item.get("link", "")),
                "text": str(item.get("snippet", ""))[:2000], "date": item.get("date")} for item in results]
    return {"sources": [item for item in sources if item["url"]], "error": "Search returned no results." if not results else None}


async def wikipedia_search(query: str, limit: int = 3) -> dict:
    if not query.strip() or len(query) > 300:
        raise ValueError("Wikipedia queries must contain 1–300 characters.")
    try:
        data = await get_json("https://en.wikipedia.org/w/api.php", params={
            "action": "query", "format": "json", "generator": "search", "gsrsearch": query,
            "gsrnamespace": 0, "gsrlimit": max(1, min(5, limit)), "prop": "extracts|info",
            "exintro": 1, "explaintext": 1, "exlimit": "max", "inprop": "url",
        }, headers=wikimedia_headers())
    except ExternalServiceError as exc:
        if exc.status_code == 403:
            message = "Wikipedia blocked this server's automated request (HTTP 403). Check its Wikimedia User-Agent/contact information and access policy."
        elif exc.status_code == 429:
            message = "Wikipedia is rate limiting requests (HTTP 429). Try again later."
        else:
            message = f"Wikipedia is temporarily unavailable: {exc}"
        return {"error": message, "error_code": exc.code, "http_status": exc.status_code, "sources": []}
    if not isinstance(data, dict) or data.get("error"):
        return {"error": "Wikipedia could not process the search. No facts were verified.", "error_code": "api_error", "sources": []}
    pages = data.get("query", {}).get("pages", {}).values()
    return {"sources": [{"title": page.get("title", "Wikipedia"), "url": safe_url(page.get("fullurl", "")),
                         "text": str(page.get("extract", ""))[:7000]} for page in sorted(pages, key=lambda page: page.get("index", 0))]}
