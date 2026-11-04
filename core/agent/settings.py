"""Agent settings contain no credential defaults. Secrets are read only from the environment."""
import json
import os
import secrets


def integer(name: str, default: int, minimum: int = 1, maximum: int = 100000) -> int:
    try:
        return max(minimum, min(maximum, int(os.getenv(name, default))))
    except ValueError:
        return default


def enabled() -> bool:
    return os.getenv("MCP_ENABLED", "true").lower() in {"true", "1", "yes", "on"}


def internal_url() -> str:
    port = integer("PORT", integer("MCP_INTERNAL_PORT", 8000), maximum=65535)
    return os.getenv("MCP_INTERNAL_URL", f"http://127.0.0.1:{port}/mcp/").rstrip("/") + "/"


def public_url() -> str:
    return os.getenv("APP_URL", "http://localhost:8000").rstrip("/") + "/mcp/"


AUTH_SECRET = os.getenv("MCP_AUTH_SECRET") or secrets.token_urlsafe(48)
TOOL_TIMEOUT = integer("MCP_TOOL_TIMEOUT", 15, maximum=60)
TURN_TIMEOUT = integer("MCP_TURN_TIMEOUT", 180, maximum=600)
MAX_CALLS = integer("MCP_MAX_TOOL_CALLS", 8, maximum=20)
MAX_ROUNDS = integer("MCP_MAX_ROUNDS", 5, maximum=10)
MAX_RESULT_CHARS = integer("MCP_MAX_RESULT_CHARS", 24000, minimum=1000, maximum=60000)


def legacy_database_access(user: dict | None) -> bool:
    """Preserve access restrictions on old private chats; never enables an MCP tool."""
    if not user:
        return False
    users = {value.strip() for value in os.getenv("MCP_DB_ALLOWED_USER_IDS", "").split(",") if value.strip()}
    admin_allowed = os.getenv("MCP_DB_ALLOW_ADMINS", "false").lower() in {"true", "1", "yes"}
    return str(user.get("_id", "")) in users or (admin_allowed and user.get("role") == "admin")


def remote_servers() -> list[dict]:
    try:
        value = json.loads(os.getenv("MCP_REMOTE_SERVERS_JSON", "[]"))
        return value[:4] if isinstance(value, list) else []
    except ValueError:
        return []
