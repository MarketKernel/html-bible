"""Cognito Hosted UI endpoints, imitated: the client uses the same code later.

    GET  /oauth2/authorize   stub sign-in page (name field) → redirect with ?code&state
    POST /oauth2/authorize   the page's form submit
    POST /oauth2/token       authorization_code (PKCE S256) and refresh_token grants
    POST /oauth2/revoke      forget a refresh token
    GET  /logout             redirect to logout_uri
    GET  /.well-known/openid-configuration

Takes API Gateway v2 events like the API handlers. Errors of the token
endpoint use the OAuth format `{ "error", "error_description" }`, as Cognito does.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import re
import secrets
from typing import Dict, Optional
from urllib.parse import parse_qs, urlencode, urlsplit

from ..core.app import get_app
from ..core.http import body_text
from . import tokens

VERIFIER_RE = re.compile(r"^[A-Za-z0-9\-._~]{43,128}$")
NAME_MAX = 40


def _response(status: int, body: str, content_type: str, headers: Optional[Dict[str, str]] = None) -> dict:
    out = {"Content-Type": content_type, "Cache-Control": "no-store"}
    out.update(headers or {})
    return {"statusCode": status, "headers": out, "body": body, "isBase64Encoded": False}


def _json(status: int, body: dict) -> dict:
    return _response(status, json.dumps(body), "application/json; charset=utf-8", {"Pragma": "no-cache"})


def _oauth_error(error: str, description: str, status: int = 400) -> dict:
    return _json(status, {"error": error, "error_description": description})


def _redirect(location: str) -> dict:
    return _response(302, "", "text/plain; charset=utf-8", {"Location": location})


def _with_query(uri: str, params: dict) -> str:
    query = urlencode({k: v for k, v in params.items() if v is not None})
    return f"{uri}{'&' if '?' in uri else '?'}{query}"


def _redirect_allowed(app, uri: Optional[str]) -> bool:
    """Cognito only redirects to registered URIs; the stub accepts the CORS allow-list's origins."""
    if not uri:
        return False
    parts = urlsplit(uri)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.fragment:
        return False
    return app.config.origin_allowed(f"{parts.scheme}://{parts.netloc}")


def _form(event: dict) -> Dict[str, str]:
    return {k: v[0] for k, v in parse_qs(body_text(event), keep_blank_values=True).items()}


def _params(event: dict) -> Dict[str, str]:
    return dict(event.get("queryStringParameters") or {})


# ------------------------------------------------------------------ the page

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in (stub)</title>
<style>
body {{ font: 16px/1.4 system-ui, sans-serif; background: #f3f1ec; color: #222; margin: 0; padding: 16px; }}
main {{ max-width: 380px; margin: 8vh auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px #0002; }}
.stub {{ background: #fff3c4; border: 1px dashed #b38f00; border-radius: 8px; padding: 8px 10px; font-size: 13px; }}
label {{ display: block; margin: 16px 0 4px; font-weight: 600; }}
input[type=text] {{ width: 100%; box-sizing: border-box; font: inherit; padding: 8px; border: 1px solid #aaa; border-radius: 6px; }}
.providers label {{ font-weight: normal; margin: 4px 0; }}
.row {{ display: flex; gap: 8px; margin-top: 20px; }}
button {{ font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #555; background: #fff; cursor: pointer; }}
button[value=allow] {{ background: #222; color: #fff; }}
.error {{ color: #b00020; }}
</style></head>
<body><main>
<p class="stub"><b>DEVELOPMENT STUB</b> — not a real {label} sign-in. Any name works;
the same name with the same provider is the same user.</p>
<h1>Sign in as… ({label})</h1>
{error}
<form method="post" action="/oauth2/authorize">
{hidden}
{providers}
<label for="name">Display name</label>
<input type="text" id="name" name="name" maxlength="{name_max}" required autofocus value="{name}">
<div class="row">
<button type="submit" name="action" value="allow">Sign in</button>
<button type="submit" name="action" value="deny" formnovalidate>Cancel</button>
</div>
</form>
</main></body></html>
"""

ERROR_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in error (stub)</title></head>
<body style="font: 16px system-ui, sans-serif; padding: 16px"><p><b>DEVELOPMENT STUB</b></p>
<h1>Sign-in error</h1><p>{message}</p></body></html>
"""

AUTHORIZE_FIELDS = (
    "response_type", "client_id", "redirect_uri", "state", "code_challenge",
    "code_challenge_method", "identity_provider", "scope",
)


def _error_page(message: str, status: int = 400) -> dict:
    return _response(status, ERROR_PAGE.format(message=html.escape(message)), "text/html; charset=utf-8")


def _page(params: Dict[str, str], name: str = "", error: str = "") -> dict:
    idp = params.get("identity_provider")
    label = tokens.IDENTITY_PROVIDERS[idp][2] if idp in tokens.IDENTITY_PROVIDERS else "Google / Apple / Microsoft"
    hidden = "\n".join(
        f'<input type="hidden" name="{k}" value="{html.escape(params[k])}">'
        for k in AUTHORIZE_FIELDS
        if params.get(k) is not None and not (k == "identity_provider" and idp not in tokens.IDENTITY_PROVIDERS)
    )
    providers = ""
    if idp not in tokens.IDENTITY_PROVIDERS:
        providers = '<div class="providers"><label>Provider</label>' + "".join(
            f'<label><input type="radio" name="identity_provider" value="{key}"{" checked" if i == 0 else ""}> {value[2]}</label>'
            for i, (key, value) in enumerate(tokens.IDENTITY_PROVIDERS.items())
        ) + "</div>"
    body = PAGE.format(
        label=html.escape(label),
        error=f'<p class="error">{html.escape(error)}</p>' if error else "",
        hidden=hidden,
        providers=providers,
        name_max=NAME_MAX,
        name=html.escape(name),
    )
    return _response(200, body, "text/html; charset=utf-8")


def _check_authorize(app, params: Dict[str, str]) -> Optional[dict]:
    """None when the request is fine; otherwise the response to send."""
    if not params.get("client_id"):
        return _error_page("client_id is required")
    if app.config.client_ids is not None and params["client_id"] not in app.config.client_ids:
        return _error_page("Unknown client_id")
    redirect_uri = params.get("redirect_uri")
    if not _redirect_allowed(app, redirect_uri):
        # Never redirect to an unchecked address: show the error here.
        return _error_page("redirect_uri is missing or not allowed (http://localhost:*, http://127.0.0.1:*, the site)")
    state = params.get("state")
    problem = None
    if params.get("response_type") != "code":
        problem = ("unsupported_response_type", "response_type must be code")
    elif not params.get("code_challenge"):
        problem = ("invalid_request", "code_challenge is required (PKCE)")
    elif params.get("code_challenge_method") != "S256":
        problem = ("invalid_request", "code_challenge_method must be S256")
    elif params.get("identity_provider") and params["identity_provider"] not in tokens.IDENTITY_PROVIDERS:
        problem = ("invalid_request", "identity_provider must be Google, SignInWithApple or Microsoft")
    if problem:
        return _redirect(_with_query(redirect_uri, {"error": problem[0], "error_description": problem[1], "state": state}))
    return None


def authorize_get(event: dict) -> dict:
    app = get_app()
    params = _params(event)
    return _check_authorize(app, params) or _page(params)


def authorize_post(event: dict) -> dict:
    app = get_app()
    form = _form(event)
    params = {k: form[k] for k in AUTHORIZE_FIELDS if k in form}
    problem = _check_authorize(app, params)
    if problem:
        return problem
    if form.get("action") == "deny":
        return _redirect(_with_query(params["redirect_uri"], {
            "error": "access_denied", "error_description": "The user cancelled sign-in", "state": params.get("state"),
        }))
    if params.get("identity_provider") not in tokens.IDENTITY_PROVIDERS:
        return _page(params, form.get("name", ""), "Choose a provider")
    name = " ".join(form.get("name", "").split())
    if not 1 <= len(name) <= NAME_MAX:
        return _page(params, name, f"Enter a name of 1–{NAME_MAX} characters")
    provider = tokens.IDENTITY_PROVIDERS[params["identity_provider"]][0]
    code = secrets.token_urlsafe(24)
    app.store.put("auth_codes", {
        "id": code,
        "clientId": params["client_id"],
        "redirectUri": params["redirect_uri"],
        "codeChallenge": params["code_challenge"],
        "sub": tokens.stub_sub(provider, name),
        "name": name,
        "provider": provider,
        "expiresAt": app.now() + app.config.code_ttl,
        "used": False,
    })
    return _redirect(_with_query(params["redirect_uri"], {"code": code, "state": params.get("state")}))


# ------------------------------------------------------------- token endpoint

def pkce_challenge(verifier: str) -> str:
    """RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))), no padding."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def token(event: dict) -> dict:
    app = get_app()
    content_type = ((event.get("headers") or {}).get("content-type") or "").split(";")[0].strip().lower()
    if content_type != "application/x-www-form-urlencoded":
        return _oauth_error("invalid_request", "Content-Type must be application/x-www-form-urlencoded")
    form = _form(event)
    grant = form.get("grant_type")
    client_id = form.get("client_id")
    if not client_id:
        return _oauth_error("invalid_client", "client_id is required", 400)
    if grant == "authorization_code":
        return _code_grant(app, form, client_id)
    if grant == "refresh_token":
        return _refresh_grant(app, form, client_id)
    return _oauth_error("unsupported_grant_type", "grant_type must be authorization_code or refresh_token")


def _code_grant(app, form: Dict[str, str], client_id: str) -> dict:
    for field in ("code", "redirect_uri", "code_verifier"):
        if not form.get(field):
            return _oauth_error("invalid_request", f"{field} is required")
    with app.lock:
        record = app.store.get("auth_codes", form["code"])
        if record is None:
            return _oauth_error("invalid_grant", "Unknown authorization code")
        if record["used"]:
            return _oauth_error("invalid_grant", "Authorization code already used")
        if app.now() >= record["expiresAt"]:
            return _oauth_error("invalid_grant", "Authorization code expired")
        if record["clientId"] != client_id:
            return _oauth_error("invalid_grant", "Code issued to another client")
        if record["redirectUri"] != form["redirect_uri"]:
            return _oauth_error("invalid_grant", "redirect_uri does not match the authorize request")
        verifier = form["code_verifier"]
        if not VERIFIER_RE.match(verifier) or not hmac.compare_digest(pkce_challenge(verifier), record["codeChallenge"]):
            return _oauth_error("invalid_grant", "PKCE verification failed")
        record["used"] = True  # single use, even if issuing below failed
        app.store.put("auth_codes", record)
    return _json(200, tokens.issue(app, record["sub"], record["name"], record["provider"], client_id, True))


def _refresh_grant(app, form: Dict[str, str], client_id: str) -> dict:
    refresh = form.get("refresh_token")
    if not refresh:
        return _oauth_error("invalid_request", "refresh_token is required")
    record = app.store.get("refresh_tokens", refresh)
    if record is None or app.now() >= record["expiresAt"]:
        return _oauth_error("invalid_grant", "Refresh token is invalid or expired")
    if record["clientId"] != client_id:
        return _oauth_error("invalid_grant", "Refresh token issued to another client")
    # Like Cognito: new access and ID tokens, the same refresh token (no rotation).
    return _json(200, tokens.issue(app, record["sub"], record["name"], record["provider"], client_id, False))


def revoke(event: dict) -> dict:
    app = get_app()
    form = _form(event)
    record = app.store.get("refresh_tokens", form.get("token", "")) if form.get("token") else None
    if record and record["clientId"] == form.get("client_id"):
        app.store.delete("refresh_tokens", record["id"])
    return _response(200, "", "text/plain; charset=utf-8")


def logout(event: dict) -> dict:
    app = get_app()
    params = _params(event)
    uri = params.get("logout_uri")
    if uri is None:
        return _response(200, ERROR_PAGE.replace("Sign-in error", "Signed out").format(message="You are signed out."),
                         "text/html; charset=utf-8")
    if not _redirect_allowed(app, uri):
        return _error_page("logout_uri is not allowed")
    return _redirect(uri)


def openid_configuration(event: dict) -> dict:
    base = get_app().config.issuer.rstrip("/")
    return _json(200, {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth2/authorize",
        "token_endpoint": f"{base}/oauth2/token",
        "revocation_endpoint": f"{base}/oauth2/revoke",
        "end_session_endpoint": f"{base}/logout",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "id_token_signing_alg_values_supported": ["HS256"],
        "token_endpoint_auth_methods_supported": ["none"],
    })


ACTIONS = {
    ("GET", "/oauth2/authorize"): authorize_get,
    ("POST", "/oauth2/authorize"): authorize_post,
    ("POST", "/oauth2/token"): token,
    ("POST", "/oauth2/revoke"): revoke,
    ("GET", "/logout"): logout,
    ("GET", "/.well-known/openid-configuration"): openid_configuration,
}


def handler(event: dict, context=None) -> dict:
    method, _, path = (event.get("routeKey") or "").partition(" ")
    action = ACTIONS.get((method, path))
    if action is None:
        return _error_page("Not found", 404)
    return action(event)
