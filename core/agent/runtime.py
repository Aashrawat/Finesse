"""The host FastAPI app owns this MCP server's lifespan."""
from core.agent.server import create_server

mcp_server = create_server()
mcp_app = mcp_server.streamable_http_app()
