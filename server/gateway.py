"""A tiny API Gateway (HTTP API, payload v2) for local use and tests.

Holds the route table, verifies the Bearer JWT like the JWT authorizer would,
builds the v2 event and calls the route's `handler(event, context)`.
Works in-process (no sockets), so tests and contract fixtures use it directly.
"""

from __future__ import annotations

import base64
import importlib
import json
import re
import time
import uuid
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qsl

from .auth_stub.tokens import verify_bearer
from .core import app as app_module
from .core.app import App
from .core.errors import ApiError, not_found, unauthorized
from .core.http import error_response


@dataclass(frozen=True)
class Route:
    method: str
    path: str      # template, e.g. /v1/questions/{id}
    module: str    # module with handler(event, context)
    auth: str      # "required" | "optional" | "none" (none: no token is even read)


ROUTES: List[Route] = [
    Route("GET", "/v1/health", "server.handlers.health", "none"),
    Route("GET", "/v1/me", "server.handlers.me", "required"),
    Route("PATCH", "/v1/me", "server.handlers.me", "required"),
    Route("GET", "/v1/questions", "server.handlers.questions", "optional"),
    Route("POST", "/v1/questions", "server.handlers.questions", "required"),
    Route("GET", "/v1/questions/{id}", "server.handlers.questions", "optional"),
    Route("PATCH", "/v1/questions/{id}", "server.handlers.questions", "required"),
    Route("DELETE", "/v1/questions/{id}", "server.handlers.questions", "required"),
    Route("POST", "/v1/questions/{id}/arguments", "server.handlers.arguments", "required"),
    Route("PATCH", "/v1/arguments/{id}", "server.handlers.arguments", "required"),
    Route("DELETE", "/v1/arguments/{id}", "server.handlers.arguments", "required"),
    Route("POST", "/v1/arguments/{id}/verses", "server.handlers.verses", "required"),
    Route("DELETE", "/v1/verses/{id}", "server.handlers.verses", "required"),
    Route("GET", "/v1/verses/{id}/rating", "server.handlers.verses", "optional"),
    Route("POST", "/v1/verses/{id}/interpretations", "server.handlers.interpretations", "required"),
    Route("PATCH", "/v1/interpretations/{id}", "server.handlers.interpretations", "required"),
    Route("DELETE", "/v1/interpretations/{id}", "server.handlers.interpretations", "required"),
    Route("PUT", "/v1/votes/verse/{id}", "server.handlers.votes", "required"),
    Route("PUT", "/v1/votes/interpretation/{id}", "server.handlers.votes", "required"),
    Route("GET", "/v1/verse-tags", "server.handlers.verse_tags", "optional"),
    # Cognito Hosted UI imitation (not behind the JWT authorizer)
    Route("GET", "/oauth2/authorize", "server.auth_stub.oauth", "none"),
    Route("POST", "/oauth2/authorize", "server.auth_stub.oauth", "none"),
    Route("POST", "/oauth2/token", "server.auth_stub.oauth", "none"),
    Route("POST", "/oauth2/revoke", "server.auth_stub.oauth", "none"),
    Route("GET", "/logout", "server.auth_stub.oauth", "none"),
    Route("GET", "/.well-known/openid-configuration", "server.auth_stub.oauth", "none"),
]


def _pattern(template: str) -> "re.Pattern[str]":
    regex = re.sub(r"\\\{(\w+)\\\}", r"(?P<\1>[^/]+)", re.escape(template))
    return re.compile(f"^{regex}$")


_COMPILED = [(route, _pattern(route.path)) for route in ROUTES]


def owns(path: str) -> bool:
    """Whether a path belongs to the API/auth side (as opposed to static files)."""
    return path == "/v1" or path.startswith("/v1/") or path.startswith("/oauth2/") or path in (
        "/logout", "/.well-known/openid-configuration")


def match(method: str, path: str) -> Tuple[Optional[Route], Dict[str, str], List[str]]:
    """(route, path parameters, methods allowed on this path)."""
    allowed = []
    for route, pattern in _COMPILED:
        found = pattern.match(path)
        if found:
            allowed.append(route.method)
            if route.method == method:
                return route, found.groupdict(), allowed
    return None, {}, allowed


class LambdaContext:
    """The bits of the Lambda context object a handler might read."""

    function_name = "html-bible-local"
    memory_limit_in_mb = 128

    def __init__(self):
        self.aws_request_id = str(uuid.uuid4())

    @staticmethod
    def get_remaining_time_in_millis() -> int:
        return 30000


def _claims_as_gateway_passes_them(claims: dict) -> Dict[str, str]:
    """HTTP API's JWT authorizer hands claims over as strings; mimic that so
    handlers never rely on richer types than they will get in AWS."""
    return {k: v if isinstance(v, str) else json.dumps(v, separators=(",", ":")) for k, v in claims.items()}


def build_event(
    route: Route,
    params: Dict[str, str],
    method: str,
    path: str,
    raw_query: str,
    headers: Dict[str, str],
    body: bytes,
    claims: Optional[dict],
    source_ip: str = "127.0.0.1",
) -> dict:
    now = time.time()
    lower = {k.lower(): v for k, v in headers.items()}
    query: Dict[str, str] = {}
    for key, value in parse_qsl(raw_query, keep_blank_values=True):
        query[key] = f"{query[key]},{value}" if key in query else value  # v2 joins repeats with commas
    try:
        text, encoded = body.decode("utf-8"), False
    except UnicodeDecodeError:
        text, encoded = base64.b64encode(body).decode("ascii"), True
    context = {
        "accountId": "local",
        "apiId": "local",
        "domainName": lower.get("host", "localhost"),
        "http": {
            "method": method,
            "path": path,
            "protocol": "HTTP/1.1",
            "sourceIp": source_ip,
            "userAgent": lower.get("user-agent", ""),
        },
        "requestId": str(uuid.uuid4()),
        "routeKey": f"{route.method} {route.path}",
        "stage": "$default",
        "time": time.strftime("%d/%b/%Y:%H:%M:%S +0000", time.gmtime(now)),
        "timeEpoch": int(now * 1000),
    }
    if claims is not None:
        context["authorizer"] = {"jwt": {"claims": _claims_as_gateway_passes_them(claims), "scopes": None}}
    event = {
        "version": "2.0",
        "routeKey": f"{route.method} {route.path}",
        "rawPath": path,
        "rawQueryString": raw_query,
        "headers": lower,
        "requestContext": context,
        "body": text if body else None,
        "isBase64Encoded": encoded,
    }
    if query:
        event["queryStringParameters"] = query
    if params:
        event["pathParameters"] = params
    return event


def handle(
    app: App,
    method: str,
    path: str,
    raw_query: str = "",
    headers: Optional[Dict[str, str]] = None,
    body: bytes = b"",
    source_ip: str = "127.0.0.1",
) -> dict:
    """Route one request; returns the handler's (or the gateway's own) v2 response dict."""
    headers = headers or {}
    if app_module._app is not app:
        app_module.set_app(app)  # handlers look the app up like a Lambda would
    route, params, allowed = match(method, path)
    if route is None:
        if allowed:
            error = ApiError(405, "method_not_allowed", f"Use {', '.join(allowed)} on this path",
                             headers={"Allow": ", ".join(allowed)})
            return error_response(error)
        return error_response(not_found("No such route"))
    claims = None
    if route.auth != "none":
        header = next((v for k, v in headers.items() if k.lower() == "authorization"), None)
        claims, error = verify_bearer(app, header)
        if error is not None:
            return error_response(error)
        if route.auth == "required" and claims is None:
            return error_response(unauthorized())
    event = build_event(route, params, method, path, raw_query, headers, body, claims, source_ip)
    module = importlib.import_module(route.module)
    return module.handler(event, LambdaContext())
