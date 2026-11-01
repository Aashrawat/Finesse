"""Subscription plans: which OpenAI model answers, and how much a user may use per day.

Free  -> gpt-4o-mini (cheap, fast)
Pro   -> gpt-5.5     (stronger)
Premium -> gpt-6.1-sol (the newest, most capable model this account can use)

Every model name and limit can be changed from .env (KB_PLAN_PRO_MODEL, KB_PLAN_PRO_MESSAGES, ...), so the
numbers can follow your real API costs. Visitors who are not logged in use the Free model (and have their own
smaller allowance, see core.kb.guest).

Paying for a plan is not connected yet: `plan` is a field on the user, changed by `PLANS_DEV_SWITCH` or by hand.
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
        features=(
            ("Higher AI message limits", False),
            ("Advanced AI models", False),
            ("Image generation", False),
            ("Voice input", False),
            ("Voice responses", True),
            ("PDF analysis", False),
            ("Web research", False),
            ("Longer conversation context", True),
            ("Faster processing", False),
        ),
    ),
    "premium": Plan(
        id="premium", name="Premium", price=24.99, tagline="For power users",
        chat_model=os.getenv("KB_PLAN_PREMIUM_MODEL", "gpt-6.1-sol"),
        daily_messages=_int("KB_PLAN_PREMIUM_MESSAGES", 1000),
        daily_images=_int("KB_PLAN_PREMIUM_IMAGES", 100),
        features=(
            ("Everything in Pro", False),
            ("Newest, most powerful AI model", False),
            ("Advanced research agent", True),
            ("Higher image-generation limits", False),
            ("AI video tools", True),
            ("Advanced voice conversations", True),
            ("Large document analysis", False),
            ("Priority processing", False),
            ("More memory and context", True),
        ),
    ),
}
ORDER = ("free", "pro", "premium")


def get(plan_id: str | None) -> Plan:
    """The plan with this id; anything unknown or missing counts as Free."""
    return PLANS.get(plan_id or "", PLANS["free"])


def for_user(user: dict | None) -> Plan:
    """The plan of a logged-in user (their document), or Free for guests."""
    return get(user.get("plan") if user else None)


def status(user_id: str, plan: Plan) -> dict:
    """Today's use against the plan's limits."""
    messages, images = usage.today(user_id)
    return {
        "plan": plan.id, "plan_name": plan.name, "model": plan.chat_model,
        "messages_used": messages, "messages_limit": plan.daily_messages,
        "images_used": images, "images_limit": plan.daily_images,
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
