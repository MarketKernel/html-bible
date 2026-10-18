"""Interpretations of a verse, in the "pro" or "con" column: add, edit, delete."""

from __future__ import annotations

from ..core import pipeline
from ..core.app import get_app
from ..core.http import claims, dispatch, json_body, json_response, path_param
from ..core.views import View


def create_interpretation(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    item = pipeline.create_interpretation(app, user, path_param(event, "id"), json_body(event))
    with app.lock:
        body = View(app, user["id"]).interpretation(item)
    return json_response(201, body, {"Location": f"/v1/interpretations/{item['id']}"})


def patch_interpretation(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    item = pipeline.patch_interpretation(app, user, path_param(event, "id"), json_body(event))
    with app.lock:
        return json_response(200, View(app, user["id"]).interpretation(item))


def delete_interpretation(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    return json_response(200, pipeline.delete_interpretation(app, user, path_param(event, "id")))


ACTIONS = {
    ("POST", "/verses/{id}/interpretations"): create_interpretation,
    ("PATCH", "/interpretations/{id}"): patch_interpretation,
    ("DELETE", "/interpretations/{id}"): delete_interpretation,
}


def handler(event: dict, context=None) -> dict:
    return dispatch(event, ACTIONS)
