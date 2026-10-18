"""PUT /v1/votes/verse/{id} and /v1/votes/interpretation/{id} — set, change or remove (null) a vote."""

from __future__ import annotations

from ..core import pipeline
from ..core.app import get_app
from ..core.http import claims, dispatch, json_body, json_response, path_param
from ..core.views import View


def put_vote(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    verse = pipeline.put_vote(app, user, path_param(event, "id"), json_body(event))
    with app.lock:
        return json_response(200, View(app, user["id"]).vote_result(verse))


def put_interpretation_vote(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    item = pipeline.put_interpretation_vote(app, user, path_param(event, "id"), json_body(event))
    with app.lock:
        return json_response(200, {"votes": View(app, user["id"]).interpretation_votes(item)})


ACTIONS = {
    ("PUT", "/votes/verse/{id}"): put_vote,
    ("PUT", "/votes/interpretation/{id}"): put_interpretation_vote,
}


def handler(event: dict, context=None) -> dict:
    return dispatch(event, ACTIONS)
