from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

from api.auth import _fail, current_user
from core.auth import service
from core.auth.db import DatabaseUnavailable
from core.billing import service as billing
from core.kb import config, plans

router = APIRouter(prefix="/api/plans", tags=["plans"])


class Switch(BaseModel):
    plan: str = Field(default="", max_length=20)


@router.get("")
def list_plans(request: Request):
    """The plans (for the pricing page), the visitor's current plan and, when logged in, today's use."""
    user = current_user(request)
    current = plans.for_user(user)
    return {
        "plans": [plans.PLANS[p].public() for p in plans.ORDER],
        "current": current.id if user else None,
        "usage": plans.status(str(user["_id"]), current) if user else None,
        "billing_enabled": billing.enabled(),  # Stripe is set up: plans are bought through Checkout
        # the free switch is for testing only and is off as soon as real payments are on
        "can_switch": config.PLAN_DEV_SWITCH and not billing.enabled(),
        "currency": "CAD",
    }


@router.post("/switch")
def switch_plan(body: Switch, request: Request):
    """Change your own plan without paying. Off unless PLANS_DEV_SWITCH=1 (development and demos only)."""
    if not config.PLAN_DEV_SWITCH or billing.enabled():
        raise HTTPException(status_code=403, detail="Paid plans aren't available yet.")
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Please log in first.")
    if body.plan not in plans.PLANS:
        raise HTTPException(status_code=422, detail="Unknown plan.")
    try:
        updated = service.set_plan(str(user["_id"]), body.plan)
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)
    return {"user": service.public_user(updated)}
