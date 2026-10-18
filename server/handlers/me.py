"""GET/PATCH /v1/me — the signed-in user's profile (created on first sign-in)."""

from __future__ import annotations

from ..core import pipeline
from ..core.app import get_app
from ..core.http import claims, dispatch, json_body, json_response
from ..core.views import user_view


def get_me(event: dict) -> dict:
    user = pipeline.current_user(get_app(), claims(event))
    return json_response(200, user_view(user))


def patch_me(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    return json_response(200, user_view(pipeline.patch_me(app, user, json_body(event))))


ACTIONS = {("GET", "/me"): get_me, ("PATCH", "/me"): patch_me}


def handler(event: dict, context=None) -> dict:
    return dispatch(event, ACTIONS)
