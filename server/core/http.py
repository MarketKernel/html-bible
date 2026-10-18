"""Reading API Gateway HTTP API (payload v2) events and building their responses.

Everything a handler needs from the event goes through here, so the same
handler runs behind the local server and behind API Gateway.
"""

from __future__ import annotations

import base64
import json
import traceback
from typing import Callable, Dict, Optional, Tuple

from .errors import ApiError, not_found

JSON_TYPE = "application/json; charset=utf-8"
API_PREFIX = "/v1"


def json_response(status: int, body, headers: Optional[Dict[str, str]] = None) -> dict:
    out = {"Content-Type": JSON_TYPE, "Cache-Control": "no-store"}
    out.update(headers or {})
    return {
        "statusCode": status,
        "headers": out,
        "body": json.dumps(body, ensure_ascii=False, separators=(",", ":")),
        "isBase64Encoded": False,
    }


def error_response(error: ApiError) -> dict:
    return json_response(error.status, error.body(), error.headers)


def body_text(event: dict) -> str:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "bad_request", "The body is not UTF-8")
    return raw


def json_body(event: dict) -> dict:
    raw = body_text(event)
    if not raw.strip():
        raise ApiError(400, "bad_request", "A JSON body is required")
    try:
        value = json.loads(raw)
    except ValueError:
        raise ApiError(400, "bad_request", "The body is not valid JSON")
    if not isinstance(value, dict):
        raise ApiError(400, "bad_request", "The body must be a JSON object")
    return value


def query(event: dict) -> Dict[str, str]:
    return event.get("queryStringParameters") or {}


def path_param(event: dict, name: str) -> str:
    value = (event.get("pathParameters") or {}).get(name)
    if not value:
        raise not_found()
    return value


def claims(event: dict) -> Optional[dict]:
    """Where API Gateway's JWT authorizer puts the verified token's claims."""
    jwt = ((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}
    value = jwt.get("claims")
    return value if isinstance(value, dict) and value.get("sub") else None


def route(event: dict) -> Tuple[str, str]:
    """("GET", "/questions/{id}") — the /v1 prefix is optional, so the handlers
    work both with routes declared as "/v1/…" and behind a "v1" API mapping."""
    key = event.get("routeKey") or ""
    method, _, path = key.partition(" ")
    if path.startswith(API_PREFIX + "/"):
        path = path[len(API_PREFIX):]
    return method, path


Action = Callable[[dict], dict]


def dispatch(event: dict, actions: Dict[Tuple[str, str], Action]) -> dict:
    """Run the action for the event's route; every failure becomes a JSON error."""
    try:
        action = actions.get(route(event))
        if action is None:
            raise not_found("No such route")
        return action(event)
    except ApiError as error:
        return error_response(error)
    except Exception:  # a stub should say what broke, a Lambda should not crash silently
        traceback.print_exc()
        return error_response(ApiError(500, "internal_error", "Internal server error"))
