"""The emails Finesse sends. Each function returns (subject, html, plain text).

Everything that comes from a user or from Stripe goes through `html.escape` before it is put in the HTML.
"""

import os
from html import escape

APP_URL = os.getenv("APP_URL", "http://localhost:5173").rstrip("/")

_LIME = "#CCFF00"
_INK = "#14161F"
_MUTED = "#6b6e80"


def _first(name: str) -> str:
    return (name or "there").strip().split(" ")[0] or "there"


def _layout(heading: str, paragraphs: list[str], rows: list[tuple[str, str]] | None = None, cta: tuple[str, str] | None = None,
            code: str | None = None, footer: str = "") -> str:
    parts = [f'<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:{_INK}">{p}</p>' for p in paragraphs]
    if code:
        parts.append(
            f'<p style="margin:24px 0;text-align:center"><span style="display:inline-block;padding:14px 26px;'
            f'font:700 34px/1 \'Courier New\',monospace;letter-spacing:10px;color:{_INK};background:#f1f2f6;'
            f'border-radius:10px">{escape(code)}</span></p>'
        )
    if rows:
        cells = "".join(
            f'<tr><td style="padding:9px 0;border-top:1px solid #e7e8ee;font-size:14px;color:{_MUTED}">{escape(k)}</td>'
            f'<td style="padding:9px 0;border-top:1px solid #e7e8ee;font-size:14px;color:{_INK};text-align:right;font-weight:600">{escape(v)}</td></tr>'
            for k, v in rows
        )
        parts.append(f'<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 20px">{cells}</table>')
    if cta:
        label, url = cta
        parts.append(
            f'<p style="margin:24px 0 8px"><a href="{escape(url, quote=True)}" style="display:inline-block;padding:12px 24px;'
            f'background:{_LIME};color:#000;text-decoration:none;font-weight:700;font-size:15px;border-radius:8px">{escape(label)}</a></p>'
        )
    foot = f'<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:{_MUTED}">{footer}</p>' if footer else ""
    return (
        '<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">'
        '<table role="presentation" width="100%" style="max-width:520px" cellspacing="0" cellpadding="0">'
        f'<tr><td style="background:{_INK};padding:18px 28px;border-radius:12px 12px 0 0">'
        f'<span style="font:700 20px Arial,sans-serif;color:{_LIME};letter-spacing:0.5px">Finesse AI</span></td></tr>'
        '<tr><td style="background:#ffffff;padding:28px;border-radius:0 0 12px 12px">'
        f'<h1 style="margin:0 0 16px;font-size:22px;color:{_INK}">{escape(heading)}</h1>'
        f'{"".join(parts)}{foot}'
        '</td></tr>'
        f'<tr><td style="padding:16px 8px;text-align:center;font-size:12px;color:{_MUTED}">Finesse AI · You are receiving this because of activity on your account.</td></tr>'
        '</table></td></tr></table></body></html>'
    )


def _text(heading: str, lines: list[str], rows: list[tuple[str, str]] | None = None, cta: tuple[str, str] | None = None) -> str:
    out = [heading, "", *lines]
    if rows:
        out += ["", *[f"{k}: {v}" for k, v in rows]]
    if cta:
        out += ["", f"{cta[0]}: {cta[1]}"]
    out += ["", "- Finesse AI"]
    return "\n".join(out)


# ---- account -----------------------------------------------------------------------------

def verify_code(name: str, code: str, minutes: int) -> tuple[str, str, str]:
    heading = "Verify your Finesse AI account"
    lines = [f"Hi {_first(name)}, welcome to Finesse AI. Enter this code to verify your email address:"]
    html = _layout(heading, [escape(lines[0])], code=code, footer=(
        f"This code expires in {minutes} minutes. If you didn't create a Finesse AI account, you can ignore this email."))
    text = _text(heading, [lines[0], "", f"    {code}", "", f"This code expires in {minutes} minutes. If you didn't sign up, ignore this email."])
    return heading, html, text


def reset_code(name: str, code: str, minutes: int) -> tuple[str, str, str]:
    heading = "Reset your Finesse AI password"
    lines = [f"Hi {_first(name)}, use this code to choose a new password:"]
    html = _layout(heading, [escape(lines[0])], code=code, footer=(
        f"This code expires in {minutes} minutes. If you didn't ask to reset your password, ignore this email: your password hasn't changed."))
    text = _text(heading, [lines[0], "", f"    {code}", "", f"This code expires in {minutes} minutes. If you didn't ask for this, ignore this email."])
    return heading, html, text


def welcome(name: str) -> tuple[str, str, str]:
    heading = "Welcome to Finesse AI"
    body = [f"Hi {_first(name)}, your email is verified and your account is ready.",
            "Chat with your documents, research any topic, summarise videos and create images, all in one place."]
    html = _layout(heading, [escape(b) for b in body], cta=("Start chatting", f"{APP_URL}/chat"))
    return heading, html, _text(heading, body, cta=("Start chatting", f"{APP_URL}/chat"))


# ---- subscriptions -----------------------------------------------------------------------

def subscription_confirmed(name: str, plan: str, amount: str, interval: str) -> tuple[str, str, str]:
    heading = "Payment successful"
    rows = [("Plan", f"Finesse {plan}"), ("Amount", amount), ("Billing", interval), ("Status", "Active")]
    body = [f"Welcome to Finesse {plan}, {_first(name)}!", "Your subscription is now active. Thank you for choosing Finesse AI."]
    html = _layout(heading, [escape(b) for b in body], rows, cta=("Open Finesse", f"{APP_URL}/chat"),
                   footer=f"You can now use all of your {escape(plan)} features.")
    return f"Welcome to Finesse {plan}", html, _text(heading, body, rows, ("Open Finesse", f"{APP_URL}/chat"))


def plan_changed(name: str, old_plan: str, new_plan: str, upgrade: bool) -> tuple[str, str, str]:
    heading = f"You're now on Finesse {new_plan}" if upgrade else "Your plan has changed"
    body = [f"Hi {_first(name)}, your plan changed from {old_plan} to {new_plan}."]
    body.append("Your new features and limits are available now." if upgrade
                else "Your new limits apply from now on.")
    rows = [("Previous plan", f"Finesse {old_plan}"), ("New plan", f"Finesse {new_plan}")]
    html = _layout(heading, [escape(b) for b in body], rows, cta=("Open Finesse", f"{APP_URL}/chat"))
    return heading, html, _text(heading, body, rows, ("Open Finesse", f"{APP_URL}/chat"))


def receipt(name: str, plan: str, amount: str, date: str, invoice_url: str | None) -> tuple[str, str, str]:
    heading = "Payment receipt"
    rows = [("Plan", f"Finesse {plan}"), ("Amount paid", amount), ("Date", date)]
    body = [f"Hi {_first(name)}, we received your payment. Thank you!"]
    cta = ("View invoice", invoice_url) if invoice_url else None
    html = _layout(heading, [escape(b) for b in body], rows, cta)
    return f"Your Finesse {plan} receipt", html, _text(heading, body, rows, cta)


def payment_failed(name: str, plan: str, amount: str, update_url: str | None) -> tuple[str, str, str]:
    heading = "We couldn't take your payment"
    rows = [("Plan", f"Finesse {plan}"), ("Amount due", amount)]
    body = [f"Hi {_first(name)}, your latest payment for Finesse {plan} didn't go through.",
            "Please update your payment method so your plan isn't interrupted. We'll try the payment again automatically."]
    cta = ("Update payment method", update_url) if update_url else None
    html = _layout(heading, [escape(b) for b in body], rows, cta)
    return "Action needed: your Finesse payment failed", html, _text(heading, body, rows, cta)


def cancellation(name: str, plan: str, end_date: str | None) -> tuple[str, str, str]:
    heading = "Your subscription is cancelled"
    when = f"You'll keep your {plan} features until {end_date}, then your account moves to the Free plan." if end_date \
        else f"Your account moves to the Free plan."
    body = [f"Hi {_first(name)}, we've cancelled your Finesse {plan} subscription.", when,
            "Changed your mind? You can resubscribe any time from the Plans page."]
    cta = ("See plans", f"{APP_URL}/pricing")
    html = _layout(heading, [escape(b) for b in body], cta=cta)
    return heading, html, _text(heading, body, cta=cta)


def expired(name: str, plan: str) -> tuple[str, str, str]:
    heading = f"Your Finesse {plan} plan has ended"
    body = [f"Hi {_first(name)}, your Finesse {plan} subscription has ended, so your account is now on the Free plan.",
            "Your conversations are kept. Resubscribe any time to get your Pro features back."]
    cta = ("See plans", f"{APP_URL}/pricing")
    html = _layout(heading, [escape(b) for b in body], cta=cta)
    return heading, html, _text(heading, body, cta=cta)
