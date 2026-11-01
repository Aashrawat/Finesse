

import os

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

from api.ratelimit import RateLimiter
from core.auth import service
from core.auth.db import DatabaseUnavailable

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE = "finesse_session"
COOKIE_SECURE = os.getenv("AUTH_COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes", "on"}  # set when serving over https

_login_by_ip = RateLimiter(10, 60)
_login_by_email = RateLimiter(8, 300)
_signup_by_ip = RateLimiter(10, 600)
_code_by_ip = RateLimiter(20, 600)  # entering emailed codes
_code_by_email = RateLimiter(10, 600)
_resend_by_ip = RateLimiter(10, 600)  # asking for emailed codes
_resend_by_email = RateLimiter(5, 600)


class Credentials(BaseModel):
    email: str = Field(default="", max_length=320)
    password: str = Field(default="", max_length=1024)


class Signup(Credentials):
    name: str = Field(default="", max_length=200)


class EmailOnly(BaseModel):
    email: str = Field(default="", max_length=320)


class Verify(EmailOnly):
    code: str = Field(default="", max_length=20)


class Reset(Verify):
    password: str = Field(default="", max_length=1024)


class Profile(BaseModel):
    name: str = Field(default="", max_length=200)


def _ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _fail(exc: Exception) -> HTTPException:
    if isinstance(exc, service.AuthError):
        return HTTPException(status_code=exc.status, detail=exc.message)
    if isinstance(exc, DatabaseUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=503, detail="The accounts database had a problem. Please try again.")


def _start_login(response: Response, user: dict) -> dict:
    token = service.create_session(user["_id"])
    response.set_cookie(
        COOKIE,
        token,
        max_age=service.SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )
    return {"user": service.public_user(user)}


def current_user(request: Request) -> dict | None:
    """The logged-in user's document, or None. (Skips the database when there is no cookie.)"""
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    try:
        return service.user_for_token(token)
    except (DatabaseUnavailable, PyMongoError):
        return None


def _needs_verification(user: dict) -> dict:
    return {"verification_required": True, "email": user["email"]}


@router.post("/signup")
def signup(body: Signup, request: Request, response: Response):
    """Creates the account but does not log in: a 6-digit code is emailed and must be entered at /verify first."""
    _signup_by_ip.check(_ip(request))
    try:
        user = service.create_user(body.name, body.email, body.password)
        if user.get("email_verified"):
            return _start_login(response, user)
        service.send_verification(user, quiet_cooldown=True)  # a sign-up retried within a minute reuses the code just sent
        return _needs_verification(user)
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)


@router.post("/verify")
def verify(body: Verify, request: Request, response: Response):
    """Checks the emailed code. Only now is the account active and a login session issued."""
    _code_by_ip.check(_ip(request))
    _code_by_email.check(body.email.strip().lower()[:254])
    try:
        user = service.verify_email(body.email, body.code)
        return _start_login(response, user)
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)


@router.post("/resend")
def resend(body: EmailOnly, request: Request):
    """Emails a new sign-up code. Always answers ok, whether or not the address has an account."""
    _resend_by_ip.check(_ip(request))
    _resend_by_email.check(body.email.strip().lower()[:254])
    try:
        service.resend_code(body.email, "verify")
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)
    return {"ok": True}


@router.post("/forgot")
def forgot(body: EmailOnly, request: Request):
    """Emails a password-reset code. Always answers ok, whether or not the address has an account."""
    _resend_by_ip.check(_ip(request))
    _resend_by_email.check(body.email.strip().lower()[:254])
    try:
        service.resend_code(body.email, "reset")
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)
    return {"ok": True}


@router.post("/reset")
def reset(body: Reset, request: Request):
    _code_by_ip.check(_ip(request))
    _code_by_email.check(body.email.strip().lower()[:254])
    try:
        service.reset_password(body.email, body.code, body.password)
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)
    return {"ok": True}


@router.post("/login")
def login(body: Credentials, request: Request, response: Response):
    _login_by_ip.check(_ip(request))
    _login_by_email.check(body.email.strip().lower()[:254])
    try:
        user = service.authenticate(body.email, body.password)
        if not user.get("email_verified", True):
            # right password, but the email was never confirmed: no login, send (or reuse) a code instead
            service.send_verification(user, quiet_cooldown=True)
            return _needs_verification(user)
        return _start_login(response, user)
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    try:
        service.end_session(token)
    except (DatabaseUnavailable, PyMongoError):
        pass  # nothing more to do; the cookie is cleared below either way
    response.delete_cookie(COOKIE, path="/", httponly=True, samesite="lax", secure=COOKIE_SECURE)
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    user = current_user(request)
    return {"user": service.public_user(user) if user else None}


@router.patch("/me")
def update_me(body: Profile, request: Request):
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Please log in first.")
    try:
        return {"user": service.public_user(service.update_name(str(user["_id"]), body.name))}
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)
