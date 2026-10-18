"""Verses ("stones") of a subtopic: add, remove, and the rating to poll while `pending`."""

from __future__ import annotations

from ..core import pipeline
from ..core.app import get_app
from ..core.errors import not_found
from ..core.http import claims, dispatch, json_body, json_response, path_param
from ..core.views import View


def create_verse(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    verse = pipeline.create_verse(app, user, path_param(event, "id"), json_body(event))
    with app.lock:
        body = View(app, user["id"]).verse(verse)
    return json_response(201, body, {"Location": f"/v1/verses/{verse['id']}"})


def delete_verse(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    return json_response(200, pipeline.delete_verse(app, user, path_param(event, "id")))


def get_rating(event: dict) -> dict:
    app = get_app()
    viewer = pipeline.current_user(app, claims(event), required=False)
    with app.lock:
        verse = app.store.get("verses", path_param(event, "id"))
        if verse is None:
            raise not_found("Verse not found")
        return json_response(200, View(app, viewer and viewer["id"]).verse_rating(verse))


ACTIONS = {
    ("POST", "/arguments/{id}/verses"): create_verse,
    ("DELETE", "/verses/{id}"): delete_verse,
    ("GET", "/verses/{id}/rating"): get_rating,
}


def handler(event: dict, context=None) -> dict:
    return dispatch(event, ACTIONS)
