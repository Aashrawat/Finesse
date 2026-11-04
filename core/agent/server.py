"""One authenticated FastMCP app, mounted inside the existing FastAPI deployment."""
import os

from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

from core.agent import settings, web_tools
from core.agent.security import BackendTokenVerifier

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True)
SUPPORTED_TOOLS = {"google_search", "wikipedia_search"}


def create_server() -> FastMCP:
    hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*", *[host.strip() for host in os.getenv("MCP_ALLOWED_HOSTS", "").split(",") if host.strip()]]
    server = FastMCP(
        "Finesse read-only tools", stateless_http=True, json_response=True, streamable_http_path="/", log_level="WARNING",
        token_verifier=BackendTokenVerifier(),
        auth=AuthSettings(issuer_url=os.getenv("APP_URL", "http://localhost:8000"), resource_server_url=settings.public_url(),
                          required_scopes=["public:read"], validate_token_resource=True),
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=hosts),
    )

    @server.tool(annotations=READ_ONLY)
    async def google_search(query: str, limit: int = 5, news: bool = False) -> dict:
        """Search Google through SerpAPI for changing facts: recent news or match results, current club affiliations, prices, weather, statistics, releases and APIs. Also use for explicit Google search requests or needed verification. Set news=true only for news coverage; leave false for other searches. Search results may be delayed. Skip confident stable knowledge, basic programming concepts, math and creative writing unless sources or current facts are needed."""
        return await web_tools.google_search(query, limit, news)

    @server.tool(annotations=READ_ONLY)
    async def wikipedia_search(query: str, limit: int = 3) -> dict:
        """Find Wikipedia introductions and source URLs for stable historical, scientific or biographical facts when uncertain or when verification, sources, or a Wikipedia search are requested. Confident basic knowledge and historical facts usually need no search. Use Google for current news, prices, weather, match results, club affiliations and ongoing statistics."""
        return await web_tools.wikipedia_search(query, limit)

    return server
