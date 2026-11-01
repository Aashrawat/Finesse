"""One-time codes for confirming an email address and for resetting a password.

A code is 6 digits from a cryptographic random generator. Only a salted hash is stored (collection
`verifications`, one document per user and purpose), it expires after OTP_MINUTES, allows MAX_ATTEMPTS wrong
guesses, and a new one can only be requested every RESEND_SECONDS.
"""

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from pymongo import ReturnDocument

from core.auth.db import get_db

OTP_MINUTES = 10
MAX_ATTEMPTS = 5
RESEND_SECONDS = 60


class OtpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _hash(code: str, salt: str, user_id, purpose: str) -> str:
    pepper = os.getenv("OTP_SECRET", "")
    return hashlib.sha256(f"{pepper}|{salt}|{user_id}|{purpose}|{code}".encode("utf-8")).hexdigest()


def issue(user_id, purpose: str) -> str:
    """Make a new code for this user (replacing any older one) and return it. Raises OtpError(429) during the cooldown."""
    coll = get_db().verifications
    existing = coll.find_one({"user_id": user_id, "purpose": purpose})
    if existing:
        wait = RESEND_SECONDS - (_now() - _aware(existing["created_at"])).total_seconds()
        if wait > 0:
            raise OtpError(429, f"Please wait {int(wait) + 1}s before asking for another code.")
    code = f"{secrets.randbelow(1_000_000):06d}"
    salt = secrets.token_hex(8)
    now = _now()
    coll.replace_one(
        {"user_id": user_id, "purpose": purpose},
        {
            "user_id": user_id, "purpose": purpose, "salt": salt, "otp_hash": _hash(code, salt, user_id, purpose),
            "expires_at": now + timedelta(minutes=OTP_MINUTES), "attempts": 0, "created_at": now,
        },
        upsert=True,
    )
    return code


def check(user_id, purpose: str, code: str) -> None:
    """Return normally when the code is right (it is then used up); raise OtpError otherwise."""
    code = (code or "").strip()
    coll = get_db().verifications
    # count the attempt first, atomically, so parallel guesses can't beat the limit
    doc = coll.find_one_and_update(
        {"user_id": user_id, "purpose": purpose}, {"$inc": {"attempts": 1}}, return_document=ReturnDocument.AFTER,
    )
    if doc is None:
        raise OtpError(400, "That code isn't right or has expired. Request a new one.")
    if _aware(doc["expires_at"]) <= _now():
        coll.delete_one({"_id": doc["_id"]})
        raise OtpError(400, "That code has expired. Request a new one.")
    if doc["attempts"] > MAX_ATTEMPTS:
        coll.delete_one({"_id": doc["_id"]})
        raise OtpError(429, "Too many wrong codes. Request a new one.")
    expected = _hash(code, doc["salt"], user_id, purpose)
    if not (code.isdigit() and len(code) == 6 and hmac.compare_digest(expected, doc["otp_hash"])):
        left = MAX_ATTEMPTS - doc["attempts"]
        if left <= 0:
            coll.delete_one({"_id": doc["_id"]})
            raise OtpError(429, "Too many wrong codes. Request a new one.")
        raise OtpError(400, f"That code isn't right. {left} attempt{'s' if left != 1 else ''} left.")
    coll.delete_one({"_id": doc["_id"]})
