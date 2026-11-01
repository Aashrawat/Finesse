"""Google sign-in.

The browser goes to Google (a normal page, not a Firebase popup). Google returns an ID token
here. We check it and create a normal Finesse session cookie.
"""

import os

import requests

from core.auth.service import AuthError

_cached_client_id = ""


def _env(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip().strip('"').strip("'")
        if value:
            return value
    return ""


def project_id() -> str:
    return _env("FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID")


def api_key() -> str:
    return _env("FIREBASE_API_KEY", "VITE_FIREBASE_API_KEY")


def google_client_id() -> str:
    """Web client ID for Google sign-in (from env, or Firebase's project config)."""
    global _cached_client_id
    explicit = _env("GOOGLE_CLIENT_ID", "VITE_GOOGLE_CLIENT_ID")
    if explicit:
        return explicit
    if _cached_client_id:
        return _cached_client_id
    key = api_key()
    if not key:
        return ""
    try:
        response = requests.get(
            "https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig",
            params={"key": key},
            timeout=15,
        )
        response.raise_for_status()
        body = response.json()
        for idp in body.get("idpConfig") or []:
            provider = f"{idp.get('provider') or ''} {idp.get('providerId') or ''}".lower()
            client = (idp.get("clientId") or idp.get("client_id") or "").strip()
            if client and "google" in provider:
                _cached_client_id = client
                return client
        for idp in body.get("idpConfig") or []:
            client = (idp.get("clientId") or idp.get("client_id") or "").strip()
            if client.endswith(".apps.googleusercontent.com"):
                _cached_client_id = client
                return client
    except requests.RequestException:
        return ""
    return ""


def google_client_secret() -> str:
    return _env("GOOGLE_CLIENT_SECRET")


def public_config() -> dict | None:
    """What the browser needs, or None when Google sign-in isn't set up."""
    key = api_key()
    auth_domain = _env("FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_AUTH_DOMAIN")
    pid = project_id()
    app_id = _env("FIREBASE_APP_ID", "VITE_FIREBASE_APP_ID")
    if not (key and auth_domain and pid and app_id):
        return None
    return {"apiKey": key, "authDomain": auth_domain, "projectId": pid, "appId": app_id}


def enabled() -> bool:
    return public_config() is not None


def _from_tokeninfo(token: str) -> dict | None:
    try:
        response = requests.get("https://oauth2.googleapis.com/tokeninfo", params={"id_token": token}, timeout=15)
        if not response.ok:
            return None
        return response.json()
    except requests.RequestException:
        return None


def verify_id_token(token: str) -> dict:
    """Return Google / Firebase token claims, or raise AuthError."""
    token = (token or "").strip()
    if not token or len(token) > 16384:
        raise AuthError(401, "Google sign-in didn't finish. Please try again.")
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token
    except ImportError as exc:
        raise AuthError(503, "Google sign-in isn't available on this server.") from exc

    req = google_requests.Request()
    client = google_client_id()
    claims = None
    if client:
        try:
            claims = id_token.verify_oauth2_token(token, req, audience=client, clock_skew_in_seconds=60)
        except TypeError:
            try:
                claims = id_token.verify_oauth2_token(token, req, audience=client)
            except Exception:
                claims = None
        except Exception:
            claims = None
    if claims is None:
        claims = _from_tokeninfo(token)
        if claims and client and claims.get("aud") != client and claims.get("azp") != client:
            claims = None
    if claims is None:
        pid = project_id()
        if pid:
            try:
                claims = id_token.verify_firebase_token(token, req, audience=pid)
            except Exception:
                claims = None
    if not claims or not claims.get("email"):
        raise AuthError(401, "Google didn't share an email address. Allow email access and try again.")
    verified = claims.get("email_verified")
    if verified in {False, "false", "False", 0, "0"}:
        raise AuthError(401, "That Google account's email isn't verified yet.")
    return claims
