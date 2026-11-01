

import base64
import hashlib
import json
import os
import secrets
from urllib.parse import urlencode, quote

import requests
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

from api.ratelimit import RateLimiter
from core.auth import firebase, service
from core.auth.db import DatabaseUnavailable

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE = "finesse_session"
OAUTH_COOKIE = "finesse_google_oauth"
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


class GoogleLogin(BaseModel):
    id_token: str = Field(default="", max_length=16384)


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


@router.get("/firebase")
def firebase_config():
    """Public settings for the Google button. Missing means the button stays hidden."""
    return {"enabled": firebase.enabled(), "config": firebase.public_config()}


def _browser_origin(request: Request) -> str:
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if not host or host.startswith("127.0.0.1:8000") or host == "localhost:8000":
        host = "localhost:5173"
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip()
    if "hf.space" in host or host.endswith(":443"):
        proto = "https"
    return f"{proto}://{host}"


def _oauth_redirect_uri(request: Request) -> str:
    origin = _browser_origin(request)
    if "localhost" in origin or "127.0.0.1" in origin:
        return "http://localhost:5173/api/auth/google/callback"
    return f"{origin}/api/auth/google/callback"


@router.get("/google/start")
def google_start(request: Request, hint: str = "", intent: str = ""):
    """Send this tab to Google. After Allow, Google returns to /api/auth/google/callback."""
    client_id = firebase.google_client_id()
    if not client_id:
        raise HTTPException(
            status_code=503,
            detail="Add GOOGLE_CLIENT_ID to .env from Firebase → Authentication → Sign-in method → Google → Web client ID.",
        )
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    params = {
        "client_id": client_id,
        "redirect_uri": _oauth_redirect_uri(request),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    if hint.strip():
        params["login_hint"] = hint.strip()
    redirect = RedirectResponse(
        "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params),
        status_code=302,
    )
    redirect.set_cookie(
        OAUTH_COOKIE,
        json.dumps({"state": state, "verifier": verifier, "intent": intent.strip()[:16]}),
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )
    return redirect


def _fail_home(home: str, reason: str) -> RedirectResponse:
    done = RedirectResponse(f"{home}?google={reason}", status_code=302)
    done.delete_cookie(OAUTH_COOKIE, path="/")
    return done


@router.get("/google/callback")
def google_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    """Google returns here. We create the Finesse login and send the tab back to the app."""
    home = f"{_browser_origin(request)}/chat"
    if error:
        return _fail_home(home, "denied")
    raw = request.cookies.get(OAUTH_COOKIE) or ""
    try:
        saved = json.loads(raw)
    except json.JSONDecodeError:
        saved = {}
    if not code or not state or state != saved.get("state") or not saved.get("verifier"):
        return _fail_home(home, "state")
    data = {
        "code": code,
        "client_id": firebase.google_client_id(),
        "redirect_uri": _oauth_redirect_uri(request),
        "grant_type": "authorization_code",
        "code_verifier": saved["verifier"],
    }
    secret = firebase.google_client_secret()
    if secret:
        data["client_secret"] = secret
    try:
        tokens = requests.post("https://oauth2.googleapis.com/token", data=data, timeout=20)
        payload = tokens.json() if tokens.headers.get("content-type", "").startswith("application/json") else {}
        try:
            payload = tokens.json()
        except ValueError:
            payload = {}
        id_token = payload.get("id_token") or ""
        if tokens.status_code >= 400 or not id_token:
            print("google token exchange failed", tokens.status_code, payload.get("error"), payload.get("error_description"))
            return _fail_home(home, "token")
        claims = firebase.verify_id_token(id_token)
        user, created = service.login_with_google(claims)
        if saved.get("intent") == "signup" and not created:
            return _fail_home(home, "exists")
        if service.google_needs_code(user):
            service.send_verification(user, quiet_cooldown=True)
            done = RedirectResponse(
                f"{home}?google=verify&email={quote(user['email'])}",
                status_code=302,
            )
            done.delete_cookie(OAUTH_COOKIE, path="/")
            return done
        session = service.create_session(user["_id"])
    except (service.AuthError, DatabaseUnavailable, PyMongoError, requests.RequestException) as exc:
        print("google login failed", type(exc).__name__, getattr(exc, "message", exc))
        return _fail_home(home, "verify")
    done = RedirectResponse(f"{home}?google=ok", status_code=302)
    done.delete_cookie(OAUTH_COOKIE, path="/")
    done.set_cookie(
        COOKIE,
        session,
        max_age=service.SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )
    return done


@router.post("/google")
def google_login(body: GoogleLogin, request: Request, response: Response):
    """The browser can also send a Google ID token; we check it and issue the login cookie."""
    _login_by_ip.check(_ip(request))
    try:
        claims = firebase.verify_id_token(body.id_token)
        user, _created = service.login_with_google(claims)
        return _start_login(response, user)
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)


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
