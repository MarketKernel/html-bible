"""Arguments (subtopics): create under a question, edit, delete."""

from __future__ import annotations

from ..core import pipeline
from ..core.app import get_app
from ..core.http import claims, dispatch, json_body, json_response, path_param
from ..core.views import View


def create_argument(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    argument = pipeline.create_argument(app, user, path_param(event, "id"), json_body(event))
    with app.lock:
        body = View(app, user["id"]).argument(argument)
    return json_response(201, body, {"Location": f"/v1/arguments/{argument['id']}"})


def patch_argument(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    argument = pipeline.patch_argument(app, user, path_param(event, "id"), json_body(event))
    with app.lock:
        return json_response(200, View(app, user["id"]).argument(argument))


def delete_argument(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    return json_response(200, pipeline.delete_argument(app, user, path_param(event, "id")))


ACTIONS = {
    ("POST", "/questions/{id}/arguments"): create_argument,
    ("PATCH", "/arguments/{id}"): patch_argument,
    ("DELETE", "/arguments/{id}"): delete_argument,
}


def handler(event: dict, context=None) -> dict:
    return dispatch(event, ACTIONS)
