"""Web tools for the research agents: search the web (Tavily) and scrape a page."""

import os
from functools import lru_cache

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from langchain.tools import tool

load_dotenv()


class MissingApiKey(RuntimeError):
    """A required API key is not configured."""


def require_tavily_key() -> str:
    key = os.getenv("TAVILY_API_KEY", "").strip()
    if not key:
        raise MissingApiKey("TAVILY_API_KEY is not set. Add it to your .env file (get a key at tavily.com).")
    return key


@lru_cache(maxsize=1)
def _tavily():
    # Created lazily so the server starts (and the video assistant works) without a Tavily key.
    from tavily import TavilyClient

    return TavilyClient(api_key=require_tavily_key())


@tool
def search_web(query: str) -> str:
    """Search the web for recent and reliable information. Returns Titles, URLs, and Snippets."""
    results = _tavily().search(query=query, max_results=5)
    out = []
    for r in results["results"]:
        out.append(f"Title: {r['title']}\nURL: {r['url']}\nSnippet: {r['content'][:300]}\n")
    return "\n-----\n".join(out)


@tool
def scrape_url(url: str) -> str:
    """Scrape and return a clean text content from a given URL for deeper reading."""
    try:
        resp = requests.get(url, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "header", "footer", "nav", "aside"]):
            tag.decompose()
        return soup.get_text(separator="\n", strip=True)[:3000]
    except Exception as e:
        return f"Error scraping website: {str(e)}"
