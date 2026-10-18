"""JWT HS256 with hmac — enough to sign and verify the stub's tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Iterable, Optional


class JwtError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code  # "invalid_token" | "token_expired"
        self.message = message


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def encode(claims: dict, secret: str, kid: str = "stub-hs256") -> str:
    header = {"alg": "HS256", "kid": kid, "typ": "JWT"}
    signing_input = ".".join(
        b64url(json.dumps(part, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        for part in (header, claims)
    )
    signature = hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(signature)}"


def decode(
    token: str,
    secret: str,
    now: float,
    issuer: Optional[str] = None,
    audiences: Optional[Iterable[str]] = None,
) -> dict:
    """Verify signature, alg, exp, iss and aud (what API Gateway's JWT authorizer checks)."""
    try:
        header_b64, claims_b64, signature_b64 = token.split(".")
        header = json.loads(b64url_decode(header_b64))
        claims = json.loads(b64url_decode(claims_b64))
        signature = b64url_decode(signature_b64)
    except (ValueError, TypeError):
        raise JwtError("invalid_token", "Malformed token")
    if not isinstance(header, dict) or header.get("alg") != "HS256" or not isinstance(claims, dict):
        raise JwtError("invalid_token", "Unsupported token")
    expected = hmac.new(
        secret.encode("utf-8"), f"{header_b64}.{claims_b64}".encode("ascii"), hashlib.sha256
    ).digest()
    if not hmac.compare_digest(signature, expected):
        raise JwtError("invalid_token", "Bad token signature")
    if issuer is not None and claims.get("iss") != issuer:
        raise JwtError("invalid_token", "Token from another issuer")
    if audiences is not None:
        allowed = set(audiences)
        if claims.get("aud") not in allowed and claims.get("client_id") not in allowed:
            raise JwtError("invalid_token", "Token for another client")
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or now >= exp:
        raise JwtError("token_expired", "Token expired")
    if not claims.get("sub"):
        raise JwtError("invalid_token", "Token without subject")
    return claims
