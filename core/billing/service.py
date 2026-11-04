"""Paid plans with Stripe: Checkout to subscribe, the Customer Portal to manage, and webhooks as the source of truth.

Access is only ever granted or removed by Stripe's webhook events (never by the page the browser returns to after
paying). Each event is processed once (its id is stored), and the user's emails are sent from here.

Settings (.env):
    STRIPE_SECRET_KEY       sk_test_... / sk_live_...
    STRIPE_WEBHOOK_SECRET   whsec_... (Stripe Dashboard -> Developers -> Webhooks, or `stripe listen`)
    STRIPE_PRICE_PRO        price_... of the monthly Pro price
    APP_URL                 where the site lives (Stripe sends people back here), default http://localhost:5173

Webhook events to enable: checkout.session.completed, customer.subscription.created / .updated / .deleted,
invoice.paid, invoice.payment_failed.

The user's document keeps `plan` (what the app enforces) and `subscription` {customer_id, subscription_id, price_id,
status, current_period_end, cancel_at_period_end}.
"""

import logging
import os
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from pymongo.errors import DuplicateKeyError

from core.auth.db import get_db
from core.kb import plans
from core.mailer import sender, templates

_logger = logging.getLogger("finesse.billing")

ACTIVE = {"active", "trialing", "past_due"}  # past_due keeps access while Stripe retries the payment
ZERO_DECIMAL = {"jpy", "krw", "vnd", "clp"}


class BillingError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---- settings --------------------------------------------------------------------------------

def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def app_url() -> str:
    return (_env("APP_URL") or "http://localhost:5173").rstrip("/")


def price_ids() -> dict[str, str]:
    """{plan id: Stripe price id} for the plans that are configured."""
    found = {"pro": _env("STRIPE_PRICE_PRO")}
    return {plan: price for plan, price in found.items() if price}


def plan_for_price(price_id: str | None) -> str | None:
    for plan, price in price_ids().items():
        if price == price_id:
            return plan
    # Recognize existing subscriptions to the retired tier without offering it for checkout.
    legacy_price = _env("STRIPE_PRICE_PREMIUM")
    if legacy_price and price_id == legacy_price:
        return "pro"
    return None


def enabled() -> bool:
    """Payments are on when the key and the Pro price are set."""
    return bool(_env("STRIPE_SECRET_KEY")) and bool(price_ids().get("pro"))


def _stripe():
    import stripe

    key = _env("STRIPE_SECRET_KEY")
    if not key:
        raise BillingError(503, "Payments aren't set up yet.")
    stripe.api_key = key
    stripe.max_network_retries = 2
    return stripe


def _stripe_failure(exc: Exception) -> BillingError:
    _logger.error("Stripe request failed: %s", exc)
    return BillingError(502, "We couldn't reach the payment provider. Please try again in a moment.")


# ---- small helpers ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dig(obj: Any, *path: Any, default: Any = None) -> Any:
    """obj["a"]["b"][0] without the KeyErrors: missing steps give `default`."""
    for step in path:
        try:
            obj = obj[step]
        except (KeyError, IndexError, TypeError):
            return default
        if obj is None:
            return default
    return obj


def _when(epoch: Any) -> datetime | None:
    return datetime.fromtimestamp(int(epoch), timezone.utc) if epoch else None


def _money(cents: Any, currency: str | None) -> str:
    code = (currency or "cad").lower()
    amount = float(cents or 0) if code in ZERO_DECIMAL else float(cents or 0) / 100
    return f"${amount:,.2f} {code.upper()}"


def _date(value: datetime | None) -> str | None:
    return f"{value:%B} {value.day}, {value:%Y}" if value else None


def _plan_name(plan_id: str | None) -> str:
    return plans.get(plan_id).name


def _user_by_id(raw: Any) -> dict | None:
    try:
        return get_db().users.find_one({"_id": ObjectId(str(raw))})
    except (InvalidId, TypeError):
        return None


def _user_by_customer(customer_id: str | None) -> dict | None:
    if not customer_id:
        return None
    return get_db().users.find_one({"subscription.customer_id": customer_id})


def _find_user(customer_id: str | None, *metadata_sources: Any) -> dict | None:
    user = _user_by_customer(customer_id)
    if user is not None:
        return user
    for meta in metadata_sources:
        uid = _dig(meta, "user_id")
        if uid:
            user = _user_by_id(uid)
            if user is not None:
                return user
    return None


def _set(user: dict, **fields: Any) -> dict:
    """Update the user's plan and/or subscription fields; returns the updated document."""
    from core.auth import service as auth

    # Admin keeps Pro even if a Stripe subscription is cancelled.
    if "plan" in fields and auth.is_admin(user):
        fields["plan"] = "pro"
    update: dict[str, Any] = {}
    for key, value in fields.items():
        update["plan" if key == "plan" else f"subscription.{key}"] = value
    return get_db().users.find_one_and_update({"_id": user["_id"]}, {"$set": update}, return_document=True)


def _email(user: dict, kind: str, content: tuple[str, str, str], event_id: str | None = None) -> None:
    """Send a billing email. A failure is logged, never raised: the webhook must not fail over an email."""
    subject, html, text = content
    try:
        sender.send(user["email"], subject, html, text, kind=kind, user_id=str(user["_id"]),
                    idempotency_key=f"{kind}-{event_id}" if event_id else None)
    except Exception:
        _logger.warning("could not send the %s email to user %s", kind, user["_id"], exc_info=True)


# ---- starting and managing a subscription ------------------------------------------------------

def _customer(user: dict) -> str:
    existing = _dig(user, "subscription", "customer_id")
    if existing:
        return existing
    stripe = _stripe()
    try:
        customer = stripe.Customer.create(email=user["email"], name=user["name"], metadata={"user_id": str(user["_id"])})
    except Exception as exc:
        raise _stripe_failure(exc)
    _set(user, customer_id=customer["id"])
    return customer["id"]


def checkout(user: dict, plan_id: str) -> dict:
    """{"url": ...} to send the browser to Stripe Checkout, or {"changed": True} when an existing
    subscription was switched to the other plan (the webhook then updates the account)."""
    prices = price_ids()
    if not enabled() or plan_id not in prices:
        raise BillingError(400, "That plan can't be bought right now.")
    sub = user.get("subscription") or {}
    if sub.get("subscription_id") and sub.get("status") in ACTIVE:
        return _change_plan(user, plan_id, prices[plan_id])
    stripe = _stripe()
    customer = _customer(user)
    uid = str(user["_id"])
    try:
        session = stripe.checkout.Session.create(
            mode="subscription",
            customer=customer,
            client_reference_id=uid,
            line_items=[{"price": prices[plan_id], "quantity": 1}],
            metadata={"user_id": uid, "plan": plan_id},
            subscription_data={"metadata": {"user_id": uid, "plan": plan_id}},
            allow_promotion_codes=True,
            success_url=f"{app_url()}/pricing?checkout=success",
            cancel_url=f"{app_url()}/pricing?checkout=cancelled",
        )
    except Exception as exc:
        raise _stripe_failure(exc)
    return {"url": session["url"]}


def _change_plan(user: dict, plan_id: str, price_id: str) -> dict:
    stripe = _stripe()
    sub_id = user["subscription"]["subscription_id"]
    try:
        current = stripe.Subscription.retrieve(sub_id)
        item = _dig(current, "items", "data", 0)
        if item is None:
            raise BillingError(400, "Your subscription can't be changed here. Use Manage billing.")
        if _dig(item, "price", "id") == price_id:
            return {"changed": True}
        stripe.Subscription.modify(
            sub_id,
            items=[{"id": item["id"], "price": price_id}],
            proration_behavior="create_prorations",
            cancel_at_period_end=False,
        )
    except BillingError:
        raise
    except Exception as exc:
        raise _stripe_failure(exc)
    return {"changed": True}


def portal(user: dict) -> str:
    """The Stripe Customer Portal: update the card, see invoices, cancel."""
    customer = _dig(user, "subscription", "customer_id")
    if not customer:
        raise BillingError(400, "There's no billing account yet. Subscribe to a plan first.")
    stripe = _stripe()
    try:
        session = stripe.billing_portal.Session.create(customer=customer, return_url=f"{app_url()}/pricing")
    except Exception as exc:
        raise _stripe_failure(exc)
    return session["url"]


# ---- webhooks ----------------------------------------------------------------------------------

def process_webhook(payload: bytes, signature: str | None) -> str:
    """Verify and handle one Stripe event. Returns "ok" or "duplicate"; raises BillingError for a bad request."""
    secret = _env("STRIPE_WEBHOOK_SECRET")
    if not secret:
        raise BillingError(503, "Webhooks aren't set up (STRIPE_WEBHOOK_SECRET is missing).")
    stripe = _stripe()
    try:
        event = stripe.Webhook.construct_event(payload, signature or "", secret)
    except (ValueError, stripe.SignatureVerificationError):
        raise BillingError(400, "Invalid signature")

    events = get_db().stripe_events
    try:  # claiming the id first makes a repeated delivery (Stripe retries) harmless
        events.insert_one({"_id": event["id"], "type": event["type"], "created_at": _now()})
    except DuplicateKeyError:
        return "duplicate"
    try:
        _dispatch(event)
    except Exception:
        events.delete_one({"_id": event["id"]})  # let Stripe's retry process it again
        raise
    return "ok"


def _dispatch(event: Any) -> None:
    kind = event["type"]
    obj = _dig(event, "data", "object", default={})
    if kind == "checkout.session.completed":
        _on_checkout_completed(obj)
    elif kind in ("customer.subscription.created", "customer.subscription.updated"):
        _on_subscription(obj, _dig(event, "data", "previous_attributes", default={}) or {}, event["id"])
    elif kind == "customer.subscription.deleted":
        _on_subscription_deleted(obj, event["id"])
    elif kind == "invoice.paid":
        _on_invoice_paid(obj, event["id"])
    elif kind == "invoice.payment_failed":
        _on_invoice_failed(obj, event["id"])


def _subscription_price(sub: Any) -> str | None:
    return _dig(sub, "items", "data", 0, "price", "id")


def _period_end(sub: Any) -> datetime | None:
    # newer API versions keep the period on the subscription item, older ones on the subscription
    return _when(_dig(sub, "current_period_end") or _dig(sub, "items", "data", 0, "current_period_end"))


def _on_checkout_completed(session: Any) -> None:
    if _dig(session, "mode") != "subscription":
        return
    user = _find_user(_dig(session, "customer"), session, _dig(session, "metadata"))
    if user is None and _dig(session, "client_reference_id"):
        user = _user_by_id(_dig(session, "client_reference_id"))
    if user is None:
        _logger.warning("checkout completed for an unknown user (customer %s)", _dig(session, "customer"))
        return
    _set(user, customer_id=_dig(session, "customer"), subscription_id=_dig(session, "subscription"))


def _on_subscription(sub: Any, previous: Any, event_id: str) -> None:
    user = _find_user(_dig(sub, "customer"), _dig(sub, "metadata"))
    if user is None:
        _logger.warning("subscription event for an unknown customer %s", _dig(sub, "customer"))
        return
    price_id = _subscription_price(sub)
    new_plan = plan_for_price(price_id)
    if new_plan is None:
        _logger.warning("subscription %s has a price (%s) that isn't one of ours; ignoring", _dig(sub, "id"), price_id)
        return
    status = _dig(sub, "status", default="active")
    old_plan = plans.for_user(user).id
    effective = new_plan if status in ACTIVE else "free"
    cancelling = bool(_dig(sub, "cancel_at_period_end") or _dig(sub, "cancel_at"))
    was_cancelling = bool(_dig(previous, "cancel_at_period_end") or _dig(previous, "cancel_at"))
    ends = _period_end(sub)

    user = _set(
        user, plan=effective, status=status, price_id=price_id, subscription_id=_dig(sub, "id"),
        customer_id=_dig(sub, "customer"), current_period_end=ends, cancel_at_period_end=cancelling,
    )

    if cancelling and not was_cancelling and ("cancel_at_period_end" in previous or "cancel_at" in previous):
        _email(user, "cancellation", templates.cancellation(user["name"], _plan_name(new_plan), _date(ends)), event_id)
    if effective != old_plan and old_plan != "free" and effective != "free":
        up = plans.ORDER.index(effective) > plans.ORDER.index(old_plan)
        _email(user, "plan_changed", templates.plan_changed(user["name"], _plan_name(old_plan), _plan_name(effective), up), event_id)


def _on_subscription_deleted(sub: Any, event_id: str) -> None:
    user = _find_user(_dig(sub, "customer"), _dig(sub, "metadata"))
    if user is None:
        return
    # an old subscription ending must not cancel a newer one
    current = _dig(user, "subscription", "subscription_id")
    if current and current != _dig(sub, "id"):
        return
    had = plan_for_price(_subscription_price(sub)) or user.get("plan", "free")
    user = _set(user, plan="free", status="canceled", subscription_id=None, price_id=None,
                current_period_end=None, cancel_at_period_end=False)
    if had != "free":
        _email(user, "expired", templates.expired(user["name"], _plan_name(had)), event_id)


def _invoice_price(invoice: Any) -> str | None:
    line = _dig(invoice, "lines", "data", 0)
    return _dig(line, "price", "id") or _dig(line, "pricing", "price_details", "price")


def _invoice_subscription(invoice: Any) -> str | None:
    return _dig(invoice, "subscription") or _dig(invoice, "parent", "subscription_details", "subscription")


def _on_invoice_paid(invoice: Any, event_id: str) -> None:
    user = _find_user(_dig(invoice, "customer"), _dig(invoice, "subscription_details", "metadata"),
                      _dig(invoice, "parent", "subscription_details", "metadata"))
    paid = int(_dig(invoice, "amount_paid", default=0) or 0)
    if user is None or paid <= 0:
        return
    reason = _dig(invoice, "billing_reason")
    plan = plan_for_price(_invoice_price(invoice)) or user.get("plan", "free")
    amount = _money(paid, _dig(invoice, "currency"))
    if reason == "subscription_create":
        if user.get("plan", "free") == "free" and plan != "free":
            # grant it now: this event can arrive before the subscription events (which then confirm it)
            user = _set(user, plan=plan, status="active", subscription_id=_invoice_subscription(invoice))
        _email(user, "subscription_confirmed", templates.subscription_confirmed(user["name"], _plan_name(plan), amount, "Monthly"), event_id)
    elif reason in ("subscription_cycle", "manual", None):
        paid_at = _when(_dig(invoice, "status_transitions", "paid_at") or _dig(invoice, "created")) or _now()
        _email(user, "receipt", templates.receipt(user["name"], _plan_name(plan), amount, _date(paid_at) or "", _dig(invoice, "hosted_invoice_url")), event_id)
    # subscription_update (the charge for switching plans): the plan-change email covers it


def _on_invoice_failed(invoice: Any, event_id: str) -> None:
    user = _find_user(_dig(invoice, "customer"), _dig(invoice, "subscription_details", "metadata"),
                      _dig(invoice, "parent", "subscription_details", "metadata"))
    if user is None:
        return
    plan = plan_for_price(_invoice_price(invoice)) or user.get("plan", "free")
    due = _money(_dig(invoice, "amount_due", default=0), _dig(invoice, "currency"))
    try:
        update_url = portal(user)
    except Exception:
        update_url = f"{app_url()}/pricing"
    _email(user, "payment_failed", templates.payment_failed(user["name"], _plan_name(plan), due, update_url), event_id)
