"""Subscription plans: which OpenAI model answers, and how much a user may use per day.

Free uses its default model. Pro can choose from a server-configured model list.

Every model name and limit can be changed from .env (KB_PLAN_PRO_MODEL, KB_PLAN_PRO_MESSAGES, ...), so the
numbers can follow your real API costs. Visitors who are not logged in use the Free model (and have their own
smaller allowance, see core.kb.guest).

The retired Premium tier is treated as Pro for existing accounts.
"""

import os
from dataclasses import dataclass

from core.kb import usage


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    price: float  # per month, CAD
    tagline: str
    chat_model: str
    daily_messages: int
    daily_images: int  # 0 = image generation is not part of the plan
    history_turns: int  # last N exchanges kept verbatim in the prompt
    history_tokens: int  # token budget for those exchanges
    voice_replies: bool  # spoken answers (OpenAI TTS)
    research: bool  # the multi-agent research tool
    features: tuple[tuple[str, bool], ...]  # (text, coming soon)

    def public(self) -> dict:
        return {
            "id": self.id, "name": self.name, "price": self.price, "tagline": self.tagline,
            "model": self.chat_model, "daily_messages": self.daily_messages, "daily_images": self.daily_images,
            "features": [{"text": text, "soon": soon} for text, soon in self.features],
        }


PLANS: dict[str, Plan] = {
    "free": Plan(
        id="free", name="Free", price=0.0, tagline="Basic AI access",
        chat_model=os.getenv("KB_PLAN_FREE_MODEL", "gpt-4o-mini"),
        daily_messages=_int("KB_PLAN_FREE_MESSAGES", 30),
        daily_images=_int("KB_PLAN_FREE_IMAGES", 0),
        history_turns=_int("KB_PLAN_FREE_HISTORY_TURNS", 6),
        history_tokens=_int("KB_PLAN_FREE_HISTORY_TOKENS", _int("KB_HISTORY_TOKEN_BUDGET", 16000)),
        voice_replies=False,
        research=False,
        features=(
            ("Standard AI chat", False),
            ("Limited daily messages", False),
            ("Basic conversation history", False),
            ("Basic file uploads", False),
            ("Limited research", False),
        ),
    ),
    "pro": Plan(
        id="pro", name="Pro", price=12.99, tagline="For students and developers",
        chat_model=os.getenv("KB_PLAN_PRO_MODEL", "gpt-5.5"),
        daily_messages=_int("KB_PLAN_PRO_MESSAGES", 300),
        daily_images=_int("KB_PLAN_PRO_IMAGES", 30),
        history_turns=_int("KB_PLAN_PRO_HISTORY_TURNS", 20),
        history_tokens=_int("KB_PLAN_PRO_HISTORY_TOKENS", 32000),
        voice_replies=True,
        research=True,
        features=(
            ("Higher AI message limits", False),
            ("Choose between advanced AI models", False),
            ("Image generation", False),
            ("Voice input", False),
            ("Voice responses", False),
            ("PDF analysis", False),
            ("Advanced research", False),
            ("Longer conversation context", False),
            ("Faster processing", False),
        ),
    ),
}
ORDER = ("free", "pro")

# Server-owned allowlist. Never accept an arbitrary model id from the browser.
# KB_PLAN_PRO_MODEL remains the default; KB_PLAN_PRO_MODELS customizes the other choices.
PRO_MODELS = tuple(dict.fromkeys([
    PLANS["pro"].chat_model,
    *(model.strip() for model in os.getenv("KB_PLAN_PRO_MODELS", "gpt-6.1-terra,gpt-6.1-sol").split(",") if model.strip()),
]))
MODEL_INFO = {
    "gpt-4o-mini": ("GPT-4o mini", "Quick help with everyday questions"),
    "gpt-5.5": ("GPT-5.5", "Advanced reasoning, writing, and code"),
    "gpt-6.1-terra": ("GPT-6.1 Terra", "Fast writing and visual reasoning"),
    "gpt-6.1-sol": ("GPT-6.1 Sol", "Complex reasoning and coding"),
}


class ModelSelectionError(ValueError):
    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def model_options(plan: Plan) -> list[dict]:
    free_model = PLANS["free"].chat_model
    return [
        {
            "id": model,
            "name": MODEL_INFO.get(model, (model, "Configured chat model"))[0],
            "description": MODEL_INFO.get(model, (model, "Configured chat model"))[1],
            "pro_only": model != free_model,
            "available": model == free_model or plan.id == "pro",
        }
        for model in dict.fromkeys([free_model, *PRO_MODELS])
    ]


def select_model(plan: Plan, requested: str | None = None) -> str:
    selected = (requested or "").strip() or plan.chat_model
    option = next((model for model in model_options(plan) if model["id"] == selected), None)
    if option is None:
        raise ModelSelectionError("That model isn't available. Choose one from the model picker.", 422)
    if not option["available"]:
        raise ModelSelectionError("Smarter GPT models are available with Pro. Upgrade to choose this model.", 403)
    return selected


def get(plan_id: str | None) -> Plan:
    """The plan with this id; anything unknown or missing counts as Free."""
    return PLANS.get("pro" if plan_id == "premium" else plan_id or "", PLANS["free"])


def for_user(user: dict | None) -> Plan:
    """The plan of a logged-in user (their document), or Free for guests."""
    return get(user.get("plan") if user else None)


def status(user_id: str, plan: Plan) -> dict:
    """Today's use against the plan's limits."""
    messages, images = usage.today(user_id)
    return {
        "plan": plan.id, "plan_name": plan.name, "model": plan.chat_model,
        "models": model_options(plan),
        "messages_used": messages, "messages_limit": plan.daily_messages,
        "images_used": images, "images_limit": plan.daily_images,
        "voice_replies": plan.voice_replies, "research": plan.research,
        "blocked": messages >= plan.daily_messages,
    }


def message_block(user_id: str, plan: Plan) -> str | None:
    """None when the user may send a message, otherwise what to tell them."""
    if usage.today(user_id)[0] < plan.daily_messages:
        return None
    nxt = _next(plan)
    if nxt is None:
        return f"You've used all {plan.daily_messages} messages for today on {plan.name}. Your allowance resets tomorrow."
    return (
        f"You've used all {plan.daily_messages} messages for today on the {plan.name} plan. "
        f"Upgrade to {nxt.name} for more, or come back tomorrow."
    )


def image_block(user_id: str, plan: Plan) -> str | None:
    """None when the user may generate an image, otherwise what to tell them."""
    if plan.daily_images <= 0:
        nxt = _next(plan)
        return (
            f"Image generation isn't part of the {plan.name} plan. Upgrade to {nxt.name if nxt else 'a paid plan'} to create images."
        )
    if usage.today(user_id)[1] >= plan.daily_images:
        nxt = _next(plan)
        tail = f" Upgrade to {nxt.name} for a higher limit, or try again tomorrow." if nxt else " Try again tomorrow."
        return f"You've created all {plan.daily_images} images allowed today on the {plan.name} plan.{tail}"
    return None


def _next(plan: Plan) -> Plan | None:
    i = ORDER.index(plan.id)
    return PLANS[ORDER[i + 1]] if i + 1 < len(ORDER) else None
