"""Sending email. Three providers; the first one that is configured in .env is used:

0. Brevo (BREVO_API_KEY, EMAIL_FROM=`Finesse AI <you@gmail.com>` where that address is a verified sender in Brevo).
   Sends over HTTPS (port 443), so it works on hosts that block SMTP ports (Hugging Face Spaces) and reaches any
   recipient without a domain of your own. The free plan allows about 300 emails a day.
1. SMTP (SMTP_HOST, SMTP_USER, SMTP_PASSWORD, optional SMTP_PORT=587 and EMAIL_FROM). Works for any recipient and
   needs no domain of your own. For example Gmail: SMTP_HOST=smtp.gmail.com, SMTP_USER=you@gmail.com and
   SMTP_PASSWORD=<an App Password> (Google account -> Security -> 2-Step Verification -> App passwords).
   Gmail allows roughly 500 emails a day.
2. Resend (RESEND_API_KEY, EMAIL_FROM=`Finesse AI <verify@yourdomain.com>`). To reach everyone, the domain must be
   verified in Resend (add its SPF, DKIM and DMARC records). Without one, Resend's test sender
   `onboarding@resend.dev` only delivers to the email address of your own Resend account.

With neither configured nothing is sent: the email is printed in the backend's console instead, so sign-up can be
tried locally. Every email, sent or not, is recorded in the `email_log` collection (never the text of the email).
"""

import asyncio
import logging
import os
import json
import smtplib
import ssl
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

from core.auth.db import get_db

_logger = logging.getLogger("finesse.email")

DEFAULT_FROM = "Finesse AI <onboarding@resend.dev>"


class EmailError(RuntimeError):
    """The email couldn't be sent. The message is written for the user."""


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def provider() -> str:
    """"brevo", "smtp", "resend" or "console" (nothing configured: emails are printed, not sent)."""
    if _env("BREVO_API_KEY"):
        return "brevo"
    if _env("SMTP_HOST") and _env("SMTP_USER") and _env("SMTP_PASSWORD"):
        return "smtp"
    if _env("RESEND_API_KEY"):
        return "resend"
    return "console"


def _from_address(for_smtp: bool = False) -> str:
    configured = _env("EMAIL_FROM")
    if for_smtp:
        # SMTP servers only accept their own account as sender, so a Resend-style address won't do
        if configured and "resend.dev" not in configured:
            return configured
        return formataddr(("Finesse AI", _env("SMTP_USER")))
    return configured or DEFAULT_FROM


def _record(kind: str, to: str, status: str, user_id: str | None, provider_id: str | None = None, error: str | None = None) -> None:
    try:
        get_db().email_log.insert_one({
            "kind": kind, "to": to, "status": status, "user_id": user_id, "provider_id": provider_id,
            "error": error, "created_at": datetime.now(timezone.utc),
        })
    except Exception:
        _logger.warning("could not record the %s email", kind, exc_info=True)


def _smtp_password() -> str:
    password = _env("SMTP_PASSWORD").strip("\"'")
    # Google shows App Passwords in groups ("abcd efgh ijkl mnop") and they are used without the spaces
    return password.replace(" ", "") if _env("SMTP_HOST").lower().endswith("gmail.com") else password


def _send_smtp(to: str, subject: str, html: str, text: str) -> None:
    msg = EmailMessage()
    msg["From"] = _from_address(for_smtp=True)
    msg["To"] = to
    msg["Subject"] = subject
    if _env("EMAIL_REPLY_TO"):
        msg["Reply-To"] = _env("EMAIL_REPLY_TO")
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    host, port = _env("SMTP_HOST"), int(_env("SMTP_PORT") or 587)
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=20, context=context) as server:
            server.login(_env("SMTP_USER"), _smtp_password())
            server.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=20) as server:
            server.starttls(context=context)
            server.login(_env("SMTP_USER"), _smtp_password())
            server.send_message(msg)


def _send_resend(to: str, subject: str, html: str, text: str, idempotency_key: str | None) -> str | None:
    import resend

    resend.api_key = _env("RESEND_API_KEY")
    params: dict = {"from": _from_address(), "to": [to], "subject": subject, "html": html, "text": text}
    if _env("EMAIL_REPLY_TO"):
        params["reply_to"] = _env("EMAIL_REPLY_TO")
    options = {"idempotency_key": idempotency_key} if idempotency_key else None
    result = resend.Emails.send(params, options)  # type: ignore[arg-type]
    return str((result or {}).get("id", "")) or None


def _send_brevo(to: str, subject: str, html: str, text: str) -> str | None:
    """Brevo's transactional email API (https://developers.brevo.com). The sender must be verified in Brevo."""
    name, address = parseaddr(_env("EMAIL_FROM"))
    if not address or "resend.dev" in address:
        raise RuntimeError("Set EMAIL_FROM to a sender address verified in Brevo, e.g. Finesse AI <you@gmail.com>.")
    payload: dict = {
        "sender": {"name": name or "Finesse AI", "email": address},
        "to": [{"email": to}],
        "subject": subject,
        "htmlContent": html,
        "textContent": text,
    }
    if _env("EMAIL_REPLY_TO"):
        payload["replyTo"] = {"email": parseaddr(_env("EMAIL_REPLY_TO"))[1]}
    request = urllib.request.Request(
        "https://api.brevo.com/v3/smtp/email",
        data=json.dumps(payload).encode("utf-8"),
        headers={"api-key": _env("BREVO_API_KEY"), "content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Brevo answered {exc.code}: {exc.read().decode('utf-8', 'replace')[:300]}") from exc
    return str(body.get("messageId", "")) or None


def _explain(provider_name: str, exc: Exception) -> str:
    """What went wrong, for the server log (the user only sees a short generic message)."""
    detail = str(exc)
    low = detail.lower()
    if provider_name == "resend" and ("testing emails" in low or "verify a domain" in low or "own email" in low):
        return (
            "Resend's test sender (onboarding@resend.dev) can only email your own Resend account address. To email "
            "everyone, verify a domain at resend.com/domains and set EMAIL_FROM to an address on it, or use SMTP "
            f"(SMTP_HOST / SMTP_USER / SMTP_PASSWORD). Resend said: {detail}"
        )
    if provider_name == "smtp" and isinstance(exc, smtplib.SMTPAuthenticationError):
        return f"The SMTP server rejected the login. For Gmail use an App Password, not the account password. ({detail})"
    return f"{type(exc).__name__}: {detail}"


def send(
    to: str, subject: str, html: str, text: str, kind: str,
    user_id: str | None = None, idempotency_key: str | None = None,
) -> None:
    """Send one email (blocking: call it from a worker thread). Raises EmailError when delivery fails."""
    name = provider()
    if name == "console":
        _logger.warning("No email provider is set up (BREVO_API_KEY, SMTP_* or RESEND_API_KEY), so this email was NOT sent. It would have said:\n"
                        "  To: %s\n  Subject: %s\n  %s", to, subject, text.replace("\n", "\n  "))
        _record(kind, to, "console", user_id)
        return
    provider_id = None
    try:
        if name == "brevo":
            provider_id = _send_brevo(to, subject, html, text)
        elif name == "smtp":
            _send_smtp(to, subject, html, text)
        else:
            provider_id = _send_resend(to, subject, html, text, idempotency_key)
    except Exception as exc:
        why = _explain(name, exc)
        _logger.error("could not send the %s email through %s: %s", kind, name, why)
        _record(kind, to, "failed", user_id, error=why[:300])
        raise EmailError("We couldn't send the email right now. Please try again in a moment.") from exc
    _record(kind, to, "sent", user_id, provider_id=provider_id)


async def send_async(*args, **kwargs) -> None:
    await asyncio.to_thread(send, *args, **kwargs)
