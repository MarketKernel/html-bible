"""GET /v1/verse-tags?book=JHN&chapter=3 — which verses of a chapter are "stones" in discussions."""

from __future__ import annotations

from ..core import pipeline, refs
from ..core.app import get_app
from ..core.errors import validation
from ..core.http import claims, dispatch, json_response, query
from ..core.text import query_lang
from ..core.views import View


def verse_tags(event: dict) -> dict:
    app = get_app()
    params = query(event)
    query_lang(params)
    book = params.get("book")
    if not book:
        raise validation('"book" is required (a canonical USFM id such as JHN)', "book")
    if not refs.BOOK_RE.match(book):
        raise refs.invalid_ref(f"Unknown book id {book!r}", "book")
    refs.check_book(book, "book")
    chapter_text = params.get("chapter") or ""
    if not chapter_text.isdigit() or int(chapter_text) < 1:
        raise validation('"chapter" must be a whole number ≥ 1', "chapter")
    chapter = int(chapter_text)
    chapters = app.counts.chapters(book)
    if chapters is not None and chapter > chapters:
        raise refs.invalid_ref(f"{book} has {chapters} chapters", "chapter")
    viewer = pipeline.current_user(app, claims(event), required=False)
    with app.lock:
        tags = pipeline.verse_tags(app, book, chapter, View(app, viewer and viewer["id"]))
    return json_response(200, {"book": book, "chapter": chapter, "tags": tags})


ACTIONS = {("GET", "/verse-tags"): verse_tags}


def handler(event: dict, context=None) -> dict:
    return dispatch(event, ACTIONS)
