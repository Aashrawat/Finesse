"""Account logic: passwords, users and login sessions.

Passwords are hashed with bcrypt (after a SHA-256 step so long passwords aren't silently cut at
bcrypt's 72-byte limit). A login is a random token kept only as a SHA-256 hash in MongoDB, so a
database leak doesn't hand out working logins; the browser holds the raw token in an HttpOnly cookie.
"""

import base64
import hashlib
import os
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone

import bcrypt
from bson import ObjectId
from bson.errors import InvalidId
from pymongo.errors import DuplicateKeyError

from core.auth import otp
from core.auth.db import get_db

SESSION_DAYS = int(os.getenv("AUTH_SESSION_DAYS", "30") or 30)
MIN_PASSWORD = 8
MAX_PASSWORD = 128
MAX_NAME = 60
# Comma-separated. These accounts always get Premium and are not demoted by Stripe.
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "finesse7047@gmail.com").split(",") if e.strip()}

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class AuthError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---- validation -------------------------------------------------------------------------

def clean_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if not email or len(email) > 254 or not _EMAIL.match(email):
        raise AuthError(422, "Enter a valid email address.")
    return email


def clean_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", _CONTROL.sub("", raw or "")).strip()
    if not name:
        raise AuthError(422, "Enter your name.")
    if len(name) > MAX_NAME:
        raise AuthError(422, f"Keep your name under {MAX_NAME} characters.")
    return name


_SPECIAL = re.compile(r"[^\w\s]|_")  # anything that isn't a letter, digit or space (underscore counts)


def password_problems(password: str) -> list[str]:
    """What a new password is still missing (empty list = it's fine). Keep in step with frontend/src/lib/password.ts."""
    missing = []
    if len(password) < MIN_PASSWORD:
        missing.append(f"at least {MIN_PASSWORD} characters")
    if not re.search(r"[0-9]", password):
        missing.append("at least 1 number")
    if not _SPECIAL.search(password):
        missing.append("at least 1 special character")
    return missing


def check_password(password: str) -> str:
    """Rules for NEW passwords (sign-up). Logging in never applies them, so older accounts still work."""
    password = password or ""
    if len(password) > MAX_PASSWORD:
        raise AuthError(422, f"Keep your password under {MAX_PASSWORD} characters.")
    if password and not password.strip():
        raise AuthError(422, "Your password can't be only spaces.")
    missing = password_problems(password)
    if missing:
        if len(missing) == 1:
            listed = missing[0]
        else:
            listed = ", ".join(missing[:-1]) + " and " + missing[-1]
        raise AuthError(422, f"Password should have {listed}.")
    return password


# ---- passwords --------------------------------------------------------------------------

def _prehash(password: str) -> bytes:
    return base64.b64encode(hashlib.sha256(password.encode("utf-8")).digest())


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prehash(password), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_prehash(password), hashed.encode("ascii"))
    except ValueError:
        return False


_dummy_lock = threading.Lock()
_dummy_hash: str | None = None


def _burn_time(password: str) -> None:
    """Unknown email: still spend one bcrypt check so timing doesn't reveal which emails exist."""
    global _dummy_hash
    with _dummy_lock:
        if _dummy_hash is None:
            _dummy_hash = hash_password("not-a-real-password")
    verify_password(password, _dummy_hash)


# ---- users ------------------------------------------------------------------------------

def _iso(value) -> str | None:
    if not isinstance(value, datetime):
        return None
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value).isoformat(timespec="seconds")


def is_admin(doc: dict | None) -> bool:
    return bool(doc) and (doc.get("role") == "admin" or (doc.get("email") or "").lower() in ADMIN_EMAILS)


def apply_admin(doc: dict) -> dict:
    """Keep the admin mailbox on Premium, even if they signed up as Free."""
    if not is_admin(doc):
        return doc
    updates = {}
    if doc.get("role") != "admin":
        updates["role"] = "admin"
    if doc.get("plan") != "premium":
        updates["plan"] = "premium"
    if updates:
        get_db().users.update_one({"_id": doc["_id"]}, {"$set": updates})
        doc.update(updates)
    return doc


def public_user(doc: dict) -> dict:
    sub = doc.get("subscription") or {}
    return {
        "id": str(doc["_id"]),
        "name": doc["name"],
        "email": doc["email"],
        "plan": doc.get("plan", "free"),
        "role": "admin" if is_admin(doc) else "user",
        "email_verified": doc.get("email_verified", True),  # accounts made before verification existed count as verified
        "subscription": {
            "status": sub.get("status", "inactive"),
            "cancel_at_period_end": bool(sub.get("cancel_at_period_end", False)),
            "current_period_end": _iso(sub.get("current_period_end")),
        },
        "created_at": doc["created_at"].replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
        if doc["created_at"].tzinfo is None
        else doc["created_at"].isoformat(timespec="seconds"),
    }


def create_user(name: str, email: str, password: str) -> dict:
    address = clean_email(email)
    admin = address in ADMIN_EMAILS
    doc = {
        "name": clean_name(name),
        "email": address,
        "password_hash": hash_password(check_password(password)),
        "plan": "premium" if admin else "free",
        "role": "admin" if admin else "user",
        "email_verified": admin,  # the seeded admin can log in without an emailed code
        "subscription": {"plan": "free", "status": "inactive"},
        "created_at": _now(),
    }
    users = get_db().users
    try:
        doc["_id"] = users.insert_one(doc).inserted_id
    except DuplicateKeyError:
        existing = users.find_one({"email": doc["email"]})
        google = bool(existing) and (existing.get("auth_provider") == "google" or not existing.get("password_hash"))
        if google:
            raise AuthError(409, "This account already exists. Please log in.")
        if existing is not None and not existing.get("email_verified", True):
            # Signed up before but never confirmed the email: let them start over (new name and password),
            # so an abandoned sign-up can't lock the address.
            fields = {"name": doc["name"], "password_hash": doc["password_hash"]}
            return users.find_one_and_update({"_id": existing["_id"]}, {"$set": fields}, return_document=True)
        raise AuthError(409, "This account already exists. Please log in.")
    return doc


# ---- email codes (verify the address, reset the password) ------------------------------------

def _send_code(user: dict, purpose: str, *, quiet_cooldown: bool = False) -> None:
    """Make a code and email it. `quiet_cooldown`: if one was sent a moment ago, just carry on (it's still valid)."""
    from core.mailer import sender, templates

    try:
        code = otp.issue(user["_id"], purpose)
    except otp.OtpError as exc:
        if quiet_cooldown and exc.status == 429:
            return
        raise AuthError(exc.status, exc.message)
    make = templates.verify_code if purpose == "verify" else templates.reset_code
    subject, html, text = make(user["name"], code, otp.OTP_MINUTES)
    try:
        sender.send(user["email"], subject, html, text, kind=f"otp_{purpose}", user_id=str(user["_id"]))
    except sender.EmailError as exc:
        get_db().verifications.delete_one({"user_id": user["_id"], "purpose": purpose})  # no email, no pending code
        raise AuthError(503, str(exc))


def send_verification(user: dict, *, quiet_cooldown: bool = False) -> None:
    _send_code(user, "verify", quiet_cooldown=quiet_cooldown)


def verify_email(email: str, code: str) -> dict:
    """Check the sign-up code. On success the account is activated and its document returned."""
    wrong = AuthError(400, "That code isn't right or has expired. Request a new one.")
    try:
        address = clean_email(email)
    except AuthError:
        raise wrong
    users = get_db().users
    user = users.find_one({"email": address})
    if user is None or user.get("email_verified", True):
        raise wrong
    try:
        otp.check(user["_id"], "verify", code)
    except otp.OtpError as exc:
        raise AuthError(exc.status, exc.message)
    user = users.find_one_and_update({"_id": user["_id"]}, {"$set": {"email_verified": True}}, return_document=True)
    from core.mailer import sender, templates

    try:
        subject, html, text = templates.welcome(user["name"])
        sender.send(user["email"], subject, html, text, kind="welcome", user_id=str(user["_id"]))
    except Exception:  # the welcome email is a nicety: never fail the verification over it
        pass
    return user


def resend_code(email: str, purpose: str) -> None:
    """Send a fresh code. Says nothing about whether the address has an account (no way to look emails up)."""
    try:
        address = clean_email(email)
    except AuthError:
        return
    user = get_db().users.find_one({"email": address})
    if user is None:
        return
    verified = user.get("email_verified", True)
    if (purpose == "verify" and not verified) or (purpose == "reset" and verified):
        _send_code(user, purpose, quiet_cooldown=True)


def reset_password(email: str, code: str, new_password: str) -> None:
    wrong = AuthError(400, "That code isn't right or has expired. Request a new one.")
    try:
        address = clean_email(email)
    except AuthError:
        raise wrong
    password = check_password(new_password)
    users = get_db().users
    user = users.find_one({"email": address})
    if user is None or not user.get("email_verified", True):
        raise wrong
    try:
        otp.check(user["_id"], "reset", code)
    except otp.OtpError as exc:
        raise AuthError(exc.status, exc.message)
    users.update_one({"_id": user["_id"]}, {"$set": {"password_hash": hash_password(password)}})
    get_db().sessions.delete_many({"user_id": user["_id"]})  # log out everywhere: whoever had the old password is out


def authenticate(email: str, password: str) -> dict:
    wrong = AuthError(401, "Incorrect email or password.")
    try:
        address = clean_email(email)
    except AuthError:
        raise wrong
    user = get_db().users.find_one({"email": address})
    if user is None:
        _burn_time(password or "")
        raise wrong
    if not user.get("password_hash"):
        raise AuthError(401, "This account uses Google. Click Continue with Google.")
    if not verify_password(password or "", user["password_hash"]):
        raise wrong
    return user


def login_with_google(claims: dict) -> tuple[dict, bool]:
    """Find or create the Finesse account for a Google sign-in. New accounts still need the emailed code.

    Returns (user, created). `created` is True only when this Google click made a new account.
    """
    address = clean_email(claims["email"])
    raw_name = (claims.get("name") or "").strip() or address.split("@")[0]
    name = clean_name(raw_name)
    uid = str(claims.get("sub") or claims.get("user_id") or "")
    users = get_db().users
    existing = users.find_one({"email": address})
    admin = address in ADMIN_EMAILS
    if existing is None:
        doc = {
            "name": name,
            "email": address,
            "password_hash": None,
            "plan": "premium" if admin else "free",
            "role": "admin" if admin else "user",
            "email_verified": admin,
            "auth_provider": "google",
            "firebase_uid": uid,
            "subscription": {"plan": "free", "status": "inactive"},
            "created_at": _now(),
        }
        doc["_id"] = users.insert_one(doc).inserted_id
        return apply_admin(doc), True
    fields = {
        "auth_provider": existing.get("auth_provider") or "google",
        "firebase_uid": uid or existing.get("firebase_uid"),
    }
    if admin:
        fields["email_verified"] = True
    users.update_one({"_id": existing["_id"]}, {"$set": fields})
    existing.update(fields)
    return apply_admin(existing), False


def google_needs_code(user: dict) -> bool:
    """New Google accounts (and any still-unconfirmed mailbox) enter the emailed code before login."""
    if is_admin(user):
        return False
    return not user.get("email_verified", False)


def update_name(user_id: str, name: str) -> dict:
    cleaned = clean_name(name)
    try:
        oid = ObjectId(user_id)
    except (InvalidId, TypeError):
        raise AuthError(401, "Please log in again.")
    user = get_db().users.find_one_and_update({"_id": oid}, {"$set": {"name": cleaned}}, return_document=True)
    if user is None:
        raise AuthError(401, "Please log in again.")
    return user


def set_plan(user_id: str, plan: str) -> dict:
    try:
        oid = ObjectId(user_id)
    except (InvalidId, TypeError):
        raise AuthError(401, "Please log in again.")
    user = get_db().users.find_one_and_update({"_id": oid}, {"$set": {"plan": plan}}, return_document=True)
    if user is None:
        raise AuthError(401, "Please log in again.")
    return user


# ---- login sessions ---------------------------------------------------------------------

def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(user_id) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    get_db().sessions.insert_one({
        "token_hash": _digest(token),
        "user_id": user_id,
        "created_at": now,
        "expires_at": now + timedelta(days=SESSION_DAYS),
    })
    return token


def user_for_token(token: str | None) -> dict | None:
    if not token or len(token) > 200:
        return None
    db = get_db()
    session = db.sessions.find_one({"token_hash": _digest(token)})
    if session is None:
        return None
    expires = session["expires_at"]
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= _now():  # MongoDB's cleanup runs about once a minute, so check here too
        db.sessions.delete_one({"_id": session["_id"]})
        return None
    user = db.users.find_one({"_id": session["user_id"]})
    if user is not None and not user.get("email_verified", True):
        return None  # never a normal session for an address that wasn't confirmed
    return apply_admin(user) if user is not None else None


def end_session(token: str | None) -> None:
    if token:
        get_db().sessions.delete_one({"token_hash": _digest(token)})
