import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

from api.auth import current_user
from api.ratelimit import RateLimiter
from core.auth.db import DatabaseUnavailable
from core.billing import service

router = APIRouter(prefix="/api/billing", tags=["billing"])
_logger = logging.getLogger("finesse.billing")

_by_ip = RateLimiter(20, 60)


class Checkout(BaseModel):
    plan: str = Field(default="", max_length=20)


def _login(request: Request) -> dict:
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Please log in first.")
    return user


def _fail(exc: Exception) -> HTTPException:
    if isinstance(exc, service.BillingError):
        return HTTPException(status_code=exc.status, detail=exc.message)
    return HTTPException(status_code=503, detail="The accounts database had a problem. Please try again.")


@router.post("/checkout")
def checkout(body: Checkout, request: Request):
    """Start a subscription: returns {"url"} to open (Stripe Checkout), or {"changed": true} when an existing
    subscription was switched to this plan. Nothing is granted here: only Stripe's webhook changes the plan."""
    _by_ip.check(request.client.host if request.client else "unknown")
    user = _login(request)
    try:
        return service.checkout(user, body.plan)
    except (service.BillingError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)


@router.post("/portal")
def portal(request: Request):
    """The Stripe page for updating the card, seeing invoices and cancelling."""
    _by_ip.check(request.client.host if request.client else "unknown")
    user = _login(request)
    try:
        return {"url": service.portal(user)}
    except (service.BillingError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)


@router.post("/webhook")
async def webhook(request: Request):
    """Stripe calls this. The signature (not a login) proves the request is real."""
    import asyncio

    payload = await request.body()
    signature = request.headers.get("stripe-signature")
    try:
        result = await asyncio.to_thread(service.process_webhook, payload, signature)
    except service.BillingError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)
    except Exception:
        _logger.exception("could not process a Stripe event")  # a 500 makes Stripe retry it later
        raise HTTPException(status_code=500, detail="Could not process the event.")
    return {"received": True, "result": result}
