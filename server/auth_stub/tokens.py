"""Stub identities and the tokens issued for them, shaped like Cognito's.

Claims follow Cognito where it matters to the client and the API: `sub`,
`iss`, `aud` = client id, `token_use`, `identities` (the IdP), `name`, a fake
`email`, `cognito:username` / `username` = "<Provider>_<id>".
"""

from __future__ import annotations

import secrets
import uuid
from typing import TYPE_CHECKING, Optional, Tuple

from ..core.errors import ApiError
from . import jwt

if TYPE_CHECKING:
    from ..core.app import App

# identity_provider value (Cognito's IdP name) → (our provider id, providerType, label)
IDENTITY_PROVIDERS = {
    "Google": ("google", "Google", "Google"),
    "SignInWithApple": ("apple", "SignInWithApple", "Apple"),
    "Microsoft": ("microsoft", "OIDC", "Microsoft"),
}
PROVIDER_IDP = {value[0]: key for key, value in IDENTITY_PROVIDERS.items()}

_NAMESPACE = uuid.UUID("6f1c3a52-6a0e-4d1a-9a4b-0c2b1d5e7f90")
DEFAULT_CLIENT_ID = "html-bible-dev"


def stub_sub(provider: str, name: str) -> str:
    """The same name with the same provider is the same person: signing in as
    "Anna" with Google again (or as a seed author) gives the same user."""
    return str(uuid.uuid5(_NAMESPACE, f"{provider}:{name.strip().casefold()}"))


def fake_email(provider: str, name: str) -> str:
    local = "".join(ch for ch in name.casefold() if ch.isalnum()) or "user"
    return f"{local}@{provider}.stub.invalid"


def _claims(app: "App", sub: str, name: str, provider: str, client_id: str, token_use: str) -> dict:
    now = int(app.now())
    idp = PROVIDER_IDP[provider]
    claims = {
        "sub": sub,
        "iss": app.config.issuer,
        "aud": client_id,
        "token_use": token_use,
        "auth_time": now,
        "iat": now,
        "exp": now + app.config.token_ttl,
        "name": name,
        "email": fake_email(provider, name),
        "identities": [{
            "providerName": idp,
            "providerType": IDENTITY_PROVIDERS[idp][1],
            "userId": sub,
            "primary": "true",
        }],
    }
    if token_use == "access":
        claims.update({
            "client_id": client_id,
            "username": f"{idp}_{sub}",
            "scope": "openid profile email",
            "jti": secrets.token_hex(8),
        })
    else:
        claims.update({"cognito:username": f"{idp}_{sub}", "email_verified": True})
    return claims


def issue(app: "App", sub: str, name: str, provider: str, client_id: str, with_refresh: bool) -> dict:
    """The token endpoint's JSON response."""
    response = {
        "access_token": jwt.encode(_claims(app, sub, name, provider, client_id, "access"), app.config.jwt_secret),
        "id_token": jwt.encode(_claims(app, sub, name, provider, client_id, "id"), app.config.jwt_secret),
        "token_type": "Bearer",
        "expires_in": app.config.token_ttl,
    }
    if with_refresh:
        refresh = secrets.token_urlsafe(32)
        app.store.put("refresh_tokens", {
            "id": refresh,
            "sub": sub,
            "name": name,
            "provider": provider,
            "clientId": client_id,
            "expiresAt": app.now() + app.config.refresh_ttl,
        })
        response["refresh_token"] = refresh
    return response


def access_token_for(app: "App", sub: str, name: str, provider: str, client_id: str = DEFAULT_CLIENT_ID) -> str:
    """A ready access token without the browser dance (tests, fixtures, curl)."""
    return jwt.encode(_claims(app, sub, name, provider, client_id, "access"), app.config.jwt_secret)


def verify_bearer(app: "App", header: Optional[str]) -> Tuple[Optional[dict], Optional[ApiError]]:
    """What API Gateway's JWT authorizer does: no header → no claims; a bad one → 401."""
    if not header:
        return None, None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None, ApiError(401, "invalid_token", "Use 'Authorization: Bearer <access token>'",
                              headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = jwt.decode(token.strip(), app.config.jwt_secret, app.now(), app.config.issuer, app.config.client_ids)
    except jwt.JwtError as exc:
        return None, ApiError(401, exc.code, exc.message,
                              headers={"WWW-Authenticate": f'Bearer error="invalid_token", error_description="{exc.message}"'})
    return claims, None
