"""Account endpoints.

    POST   /api/auth/signup    {name, email, password}  -> creates the account and logs in
    POST   /api/auth/login     {email, password}
    POST   /api/auth/logout
    GET    /api/auth/me        -> {user} (user is null when logged out)
    PATCH  /api/auth/me        {name}

A login is an HttpOnly, SameSite=Lax cookie, so page scripts never see it and other sites can't
make the browser send it on a cross-site POST.
"""

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


class Credentials(BaseModel):
    email: str = Field(default="", max_length=320)
    password: str = Field(default="", max_length=1024)


class Signup(Credentials):
    name: str = Field(default="", max_length=200)


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


@router.post("/signup")
def signup(body: Signup, request: Request, response: Response):
    _signup_by_ip.check(_ip(request))
    try:
        user = service.create_user(body.name, body.email, body.password)
        return _start_login(response, user)
    except (service.AuthError, DatabaseUnavailable, PyMongoError) as exc:
        raise _fail(exc)


@router.post("/login")
def login(body: Credentials, request: Request, response: Response):
    _login_by_ip.check(_ip(request))
    _login_by_email.check(body.email.strip().lower()[:254])
    try:
        user = service.authenticate(body.email, body.password)
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
