"""Backend identities, public MCP credentials, and existing private-conversation access."""
import time
from dataclasses import dataclass

import jwt
from mcp.server.auth.provider import AccessToken

from core.agent import settings


@dataclass(frozen=True)
class Actor:
    subject: str = "guest"
    database: bool = False  # Legacy chat access only; no database tools or token scopes.
    private_context: bool = False


def actor_for_user(user: dict | None) -> Actor:
    return Actor(str(user["_id"]) if user else "guest", settings.legacy_database_access(user))


def can_read_conversation(conversation: dict, user: dict | None) -> bool:
    owner = conversation.get("private_owner")
    if not owner:
        return True
    actor = actor_for_user(user)
    return actor.subject != "guest" and actor.subject == owner and (not conversation.get("database_context") or actor.database)


def issue_token(actor: Actor) -> str:
    now = int(time.time())
    return jwt.encode({
        "sub": actor.subject, "iss": "finesse-backend", "aud": settings.public_url(),
        "iat": now, "exp": now + 600,
        "scopes": ["public:read"],
    }, settings.AUTH_SECRET, algorithm="HS256")


class BackendTokenVerifier:
    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            claims = jwt.decode(token, settings.AUTH_SECRET, algorithms=["HS256"], audience=settings.public_url(),
                                issuer="finesse-backend", options={"require": ["exp", "iat", "sub", "aud", "iss"]})
            if not isinstance(claims.get("scopes"), list):
                return None
            return AccessToken(token=token, client_id="finesse-backend", subject=claims["sub"],
                               scopes=claims["scopes"], expires_at=claims["exp"], resource=settings.public_url())
        except jwt.InvalidTokenError:
            return None
