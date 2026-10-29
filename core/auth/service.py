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

from core.auth.db import get_db

SESSION_DAYS = int(os.getenv("AUTH_SESSION_DAYS", "30") or 30)
MIN_PASSWORD = 8
MAX_PASSWORD = 128
MAX_NAME = 60

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

def public_user(doc: dict) -> dict:
    return {
        "id": str(doc["_id"]),
        "name": doc["name"],
        "email": doc["email"],
        "plan": doc.get("plan", "free"),
        "created_at": doc["created_at"].replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
        if doc["created_at"].tzinfo is None
        else doc["created_at"].isoformat(timespec="seconds"),
    }


def create_user(name: str, email: str, password: str) -> dict:
    doc = {
        "name": clean_name(name),
        "email": clean_email(email),
        "password_hash": hash_password(check_password(password)),
        "plan": "free",
        "created_at": _now(),
    }
    try:
        doc["_id"] = get_db().users.insert_one(doc).inserted_id
    except DuplicateKeyError:
        raise AuthError(409, "An account with that email already exists. Try logging in.")
    return doc


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
    if not verify_password(password or "", user["password_hash"]):
        raise wrong
    return user


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
    return db.users.find_one({"_id": session["user_id"]})


def end_session(token: str | None) -> None:
    if token:
        get_db().sessions.delete_one({"token_hash": _digest(token)})
