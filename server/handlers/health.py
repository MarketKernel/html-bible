"""GET /v1/health — the client's "is the server there?" probe."""

from __future__ import annotations

from .. import VERSION
from ..core.http import dispatch, json_response


def health(event: dict) -> dict:
    return json_response(200, {"ok": True, "version": VERSION})


ACTIONS = {("GET", "/health"): health}


def handler(event: dict, context=None) -> dict:
    return dispatch(event, ACTIONS)
