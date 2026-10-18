"""/v1/questions — list, create, read one (with subtopics, verses, interpretations), edit, delete."""

from __future__ import annotations

from ..core import pipeline
from ..core.app import get_app
from ..core.errors import not_found
from ..core.http import claims, dispatch, json_body, json_response, path_param, query
from ..core.text import query_lang
from ..core.views import View


def list_questions(event: dict) -> dict:
    app = get_app()
    params = query(event)
    query_lang(params)
    tag = (params.get("tag") or "").strip().lower() or None
    viewer = pipeline.current_user(app, claims(event), required=False)
    view = View(app, viewer and viewer["id"])
    with app.lock:
        questions = [q for q in app.store.scan("questions") if tag is None or tag in q["tags"]]
        questions.sort(key=lambda q: (q["createdAt"], q["id"]), reverse=True)
        return json_response(200, {"questions": [view.question(q, with_counts=True) for q in questions]})


def create_question(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    question = pipeline.create_question(app, user, json_body(event))
    with app.lock:
        body = View(app, user["id"]).question(question)
    return json_response(201, body, {"Location": f"/v1/questions/{question['id']}"})


def get_question(event: dict) -> dict:
    app = get_app()
    query_lang(query(event))
    viewer = pipeline.current_user(app, claims(event), required=False)
    with app.lock:
        question = app.store.get("questions", path_param(event, "id"))
        if question is None:
            raise not_found("Question not found")
        return json_response(200, View(app, viewer and viewer["id"]).question_full(question))


def patch_question(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    question = pipeline.patch_question(app, user, path_param(event, "id"), json_body(event))
    with app.lock:
        return json_response(200, View(app, user["id"]).question(question))


def delete_question(event: dict) -> dict:
    app = get_app()
    user = pipeline.current_user(app, claims(event))
    return json_response(200, pipeline.delete_question(app, user, path_param(event, "id")))


ACTIONS = {
    ("GET", "/questions"): list_questions,
    ("POST", "/questions"): create_question,
    ("GET", "/questions/{id}"): get_question,
    ("PATCH", "/questions/{id}"): patch_question,
    ("DELETE", "/questions/{id}"): delete_question,
}


def handler(event: dict, context=None) -> dict:
    return dispatch(event, ACTIONS)
