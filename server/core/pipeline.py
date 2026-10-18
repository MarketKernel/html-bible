"""Everything that changes discussions: the save pipeline (Task.md §6)

    validate → moderate() → translate() → save
      → for a verse or interpretation: verse ai.status = "pending" → evaluate(verse)

plus deletion (soft when something hangs off the item), verse votes and users.
Tallies are computed on read (views.py), so nothing needs recounting here.
Functions take stored records/ids and return stored records; handlers render.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, List, Optional

from ..llm.base import ModerationUnavailable
from . import refs as refmod
from .errors import ApiError, deleted, forbidden, not_found, unauthorized, validation
from .text import (
    LANGS, NAME_MAX, SIDE_MAX, TITLE_MAX,
    blank, clean, clean_md, clean_tags, localize, require_lang,
)

if TYPE_CHECKING:
    from .app import App

PROVIDERS = {"google": "google", "signinwithapple": "apple", "apple": "apple", "microsoft": "microsoft"}
DEFAULT_SIDES = {"pro": {"ru": "За", "en": "For"}, "con": {"ru": "Против", "en": "Against"}}


# --------------------------------------------------------------------- users

def provider_from_claims(claims: dict) -> str:
    """Cognito puts the IdP in `identities` (ID token) and in the username prefix
    ("Google_1234…", access token). API Gateway passes claims as strings, so
    `identities` may arrive JSON-encoded."""
    identities = claims.get("identities")
    if isinstance(identities, str):
        try:
            identities = json.loads(identities)
        except ValueError:
            identities = None
    names = []
    if isinstance(identities, list) and identities and isinstance(identities[0], dict):
        names.append(str(identities[0].get("providerName", "")))
    for key in ("cognito:username", "username"):
        if isinstance(claims.get(key), str) and "_" in claims[key]:
            names.append(claims[key].split("_", 1)[0])
    for name in names:
        provider = PROVIDERS.get(name.lower())
        if provider:
            return provider
    return "google"  # User.provider has three values; unknown IdPs are not configured


def current_user(app: "App", claims: Optional[dict], required: bool = True) -> Optional[dict]:
    """The signed-in user, created on their first authenticated request."""
    if not claims:
        if required:
            raise unauthorized()
        return None
    sub = str(claims["sub"])
    with app.lock:
        user = app.store.get("users", sub)
        if user is None:
            name = claims.get("name")
            name = name.strip()[:NAME_MAX] if isinstance(name, str) and name.strip() else f"User {sub[:4]}"
            user = {
                "id": sub,
                "provider": provider_from_claims(claims),
                "displayName": name,
                "createdAt": app.now_iso(),
            }
            app.store.put("users", user)
    return user


def patch_me(app: "App", user: dict, body: dict) -> dict:
    if "displayName" not in body:
        raise validation('"displayName" is required', "displayName")
    name = clean(body["displayName"], "displayName", NAME_MAX)
    moderate(app, [name], body.get("lang") if body.get("lang") in LANGS else "en")
    with app.lock:
        user = app.store.get("users", user["id"])
        user["displayName"] = name
        app.store.put("users", user)
    return user


# ------------------------------------------------------------------ helpers

def moderate(app: "App", texts: List[str], lang: str) -> None:
    try:
        result = app.moderator.moderate([t for t in texts if t], lang)
    except ModerationUnavailable:
        raise ApiError(503, "moderation_unavailable", "Moderation is unavailable; nothing was saved. Try again later.")
    if not result.allowed:
        reason = result.reason or "Rejected by moderation"
        raise ApiError(422, "moderation_rejected", reason, reason=reason)


def _get(app: "App", table: str, item_id: str, what: str) -> dict:
    item = app.store.get(table, item_id)
    if item is None:
        raise not_found(f"{what} not found")
    return item


def _own(item: dict, user: dict) -> None:
    if item["authorId"] != user["id"]:
        raise forbidden()


def _alive(item: dict) -> None:
    if item.get("deleted"):
        raise deleted()


def _clean_sides(app: "App", value, lang: str) -> dict:
    if not isinstance(value, dict):
        raise validation('"sides" must be an object { pro, con }', "sides")
    return {
        side: localize(app, clean(value.get(side), f"sides.{side}", SIDE_MAX), lang)
        for side in ("pro", "con")
    }


# ---------------------------------------------------------------- questions

def create_question(app: "App", user: dict, body: dict) -> dict:
    lang = require_lang(body)
    title = clean(body.get("title"), "title", TITLE_MAX)
    summary = clean_md(body.get("summaryMd", ""), "summaryMd", required=False)
    tags = clean_tags(body.get("tags", []))
    sides_in = body.get("sides")
    side_texts = []
    if sides_in is not None:
        if not isinstance(sides_in, dict):
            raise validation('"sides" must be an object { pro, con }', "sides")
        side_texts = [clean(sides_in.get(s), f"sides.{s}", SIDE_MAX) for s in ("pro", "con")]
    moderate(app, [title, summary] + side_texts, lang)
    if sides_in is None:
        sides = {side: dict({"orig": lang}, **texts) for side, texts in DEFAULT_SIDES.items()}
    else:
        sides = _clean_sides(app, sides_in, lang)
    question = {
        "id": app.new_id(),
        "title": localize(app, title, lang),
        "summaryMd": localize(app, summary, lang),
        "sides": sides,
        "tags": tags,
        "authorId": user["id"],
        "createdAt": app.now_iso(),
    }
    with app.lock:
        app.store.put("questions", question)
    return question


def patch_question(app: "App", user: dict, question_id: str, body: dict) -> dict:
    question = _get(app, "questions", question_id, "Question")
    _own(question, user)
    _alive(question)
    fields = [k for k in ("title", "summaryMd", "sides", "tags") if k in body]
    if not fields:
        raise validation("Nothing to change: send title, summaryMd, sides or tags")
    updates = {}
    texts = []
    lang = require_lang(body) if any(k in body for k in ("title", "summaryMd", "sides")) else None
    if "title" in body:
        texts.append(clean(body["title"], "title", TITLE_MAX))
    if "summaryMd" in body:
        texts.append(clean_md(body["summaryMd"], "summaryMd", required=False))
    if "sides" in body:
        if not isinstance(body["sides"], dict):
            raise validation('"sides" must be an object { pro, con }', "sides")
        texts += [clean(body["sides"].get(s), f"sides.{s}", SIDE_MAX) for s in ("pro", "con")]
    if "tags" in body:
        updates["tags"] = clean_tags(body["tags"])
    if lang:
        moderate(app, texts, lang)
        if "title" in body:
            updates["title"] = localize(app, clean(body["title"], "title", TITLE_MAX), lang)
        if "summaryMd" in body:
            updates["summaryMd"] = localize(app, clean_md(body["summaryMd"], "summaryMd", False), lang)
        if "sides" in body:
            updates["sides"] = _clean_sides(app, body["sides"], lang)
    with app.lock:
        question = _get(app, "questions", question_id, "Question")
        question.update(updates)
        question["updatedAt"] = app.now_iso()
        app.store.put("questions", question)
    return question


def delete_question(app: "App", user: dict, question_id: str) -> dict:
    with app.lock:
        question = _get(app, "questions", question_id, "Question")
        _own(question, user)
        if app.store.query("arguments", "questionId", question_id):
            if not question.get("deleted"):
                question.update({
                    "deleted": True,
                    "title": blank(question["title"]),
                    "summaryMd": blank(question["summaryMd"]),
                    "sides": {s: blank(t) for s, t in question["sides"].items()},
                    "updatedAt": app.now_iso(),
                })
                app.store.put("questions", question)
            return {"id": question_id, "deleted": "soft"}
        _remove(app, "questions", question_id)
        return {"id": question_id, "deleted": "hard"}


# ---------------------------------------------------------------- arguments

def create_argument(app: "App", user: dict, question_id: str, body: dict) -> dict:
    question = _get(app, "questions", question_id, "Question")
    _alive(question)
    lang = require_lang(body)
    title = clean(body.get("title"), "title", TITLE_MAX)
    summary = clean_md(body.get("summaryMd", ""), "summaryMd", required=False)
    moderate(app, [title, summary], lang)
    argument = {
        "id": app.new_id(),
        "questionId": question_id,
        "title": localize(app, title, lang),
        "summaryMd": localize(app, summary, lang),
        "authorId": user["id"],
        "createdAt": app.now_iso(),
    }
    with app.lock:
        if app.store.get("questions", question_id) is None:
            raise not_found("Question not found")
        app.store.put("arguments", argument)
    return argument


def patch_argument(app: "App", user: dict, argument_id: str, body: dict) -> dict:
    argument = _get(app, "arguments", argument_id, "Argument")
    _own(argument, user)
    _alive(argument)
    if "title" not in body and "summaryMd" not in body:
        raise validation("Nothing to change: send title or summaryMd")
    lang = require_lang(body)
    texts = {}
    if "title" in body:
        texts["title"] = clean(body["title"], "title", TITLE_MAX)
    if "summaryMd" in body:
        texts["summaryMd"] = clean_md(body["summaryMd"], "summaryMd", required=False)
    moderate(app, list(texts.values()), lang)
    localized = {k: localize(app, v, lang) for k, v in texts.items()}
    with app.lock:
        argument = _get(app, "arguments", argument_id, "Argument")
        argument.update(localized)
        argument["updatedAt"] = app.now_iso()
        app.store.put("arguments", argument)
    return argument


def delete_argument(app: "App", user: dict, argument_id: str) -> dict:
    with app.lock:
        argument = _get(app, "arguments", argument_id, "Argument")
        _own(argument, user)
        if not app.store.query("verses", "argumentId", argument_id):
            _remove(app, "arguments", argument_id)
            _collect_question(app, argument["questionId"])
            return {"id": argument_id, "deleted": "hard"}
        if not argument.get("deleted"):
            argument.update({
                "deleted": True,
                "title": blank(argument["title"]),
                "summaryMd": blank(argument["summaryMd"]),
                "updatedAt": app.now_iso(),
            })
            app.store.put("arguments", argument)
        return {"id": argument_id, "deleted": "soft"}


# ------------------------------------------------------------------- verses

def create_verse(app: "App", user: dict, argument_id: str, body: dict) -> dict:
    """Add a "stone" to a subtopic: one canonical range, unique within the subtopic."""
    argument = _get(app, "arguments", argument_id, "Argument")
    _alive(argument)
    question = _get(app, "questions", argument["questionId"], "Question")
    _alive(question)
    if "ref" not in body:
        raise validation('"ref" is required: { from, to }', "ref")
    ref = refmod.parse_range(body["ref"], app.counts, "ref")
    with app.lock:
        for existing in app.store.query("verses", "argumentId", argument_id):
            if existing["ref"] == ref:
                raise ApiError(409, "duplicate_verse", "This verse is already in the subtopic",
                               field="ref", extra={"id": existing["id"]})
        verse = {
            "id": app.new_id(),
            "argumentId": argument_id,
            "questionId": argument["questionId"],
            "ref": ref,
            "authorId": user["id"],
            "createdAt": app.now_iso(),
            "ai": {"status": "none", "verdicts": []},
        }
        app.store.put("verses", verse)
    app.scheduler.request(verse["id"])
    return app.store.get("verses", verse["id"])


def delete_verse(app: "App", user: dict, verse_id: str) -> dict:
    """Only the author, and only while nobody else voted and there are no interpretations."""
    with app.lock:
        verse = _get(app, "verses", verse_id, "Verse")
        _own(verse, user)
        votes = app.store.query("votes", "targetKey", f"verse:{verse_id}")
        if any(v["userId"] != user["id"] for v in votes):
            raise ApiError(409, "in_use", "Others have voted on this verse; it can no longer be removed")
        if app.store.query("interpretations", "verseId", verse_id):
            raise ApiError(409, "in_use", "This verse has interpretations; it can no longer be removed")
        _remove(app, "verses", verse_id)
        argument = app.store.get("arguments", verse["argumentId"])
        if argument and argument.get("deleted") and not app.store.query("verses", "argumentId", argument["id"]):
            _remove(app, "arguments", argument["id"])
            _collect_question(app, argument["questionId"])
    return {"id": verse_id, "deleted": "hard"}


# ---------------------------------------------------------- interpretations

def create_interpretation(app: "App", user: dict, verse_id: str, body: dict) -> dict:
    verse = _get(app, "verses", verse_id, "Verse")
    argument = _get(app, "arguments", verse["argumentId"], "Argument")
    _alive(argument)
    lang = require_lang(body)
    side = body.get("side")
    if side not in ("pro", "con"):
        raise validation('"side" must be "pro" or "con"', "side")
    text = clean_md(body.get("bodyMd"), "bodyMd", required=True)
    reply_to = body.get("replyTo")
    if reply_to is not None:
        target = app.store.get("interpretations", reply_to) if isinstance(reply_to, str) else None
        if target is None or target["verseId"] != verse_id:
            raise validation('"replyTo" must be an interpretation of the same verse', "replyTo")
        if target.get("deleted"):
            raise deleted("The interpretation you reply to was deleted by its author")
    moderate(app, [text], lang)
    item = {
        "id": app.new_id(),
        "verseId": verse_id,
        "argumentId": verse["argumentId"],
        "questionId": verse["questionId"],
        "side": side,
        "bodyMd": localize(app, text, lang),
        "authorId": user["id"],
        "createdAt": app.now_iso(),
    }
    if reply_to:
        item["replyTo"] = reply_to
    with app.lock:
        if app.store.get("verses", verse_id) is None:
            raise not_found("Verse not found")
        app.store.put("interpretations", item)
    app.scheduler.request(verse_id)
    return item


def patch_interpretation(app: "App", user: dict, item_id: str, body: dict) -> dict:
    item = _get(app, "interpretations", item_id, "Interpretation")
    _own(item, user)
    _alive(item)
    for fixed in ("side", "replyTo"):
        if fixed in body and body[fixed] != item.get(fixed):
            raise validation(f'"{fixed}" cannot be changed; delete and write a new one', fixed)
    if "bodyMd" not in body:
        raise validation("Nothing to change: send bodyMd")
    lang = require_lang(body)
    text = clean_md(body["bodyMd"], "bodyMd", required=True)
    moderate(app, [text], lang)
    localized = localize(app, text, lang)
    with app.lock:
        item = _get(app, "interpretations", item_id, "Interpretation")
        item["bodyMd"] = localized
        item["updatedAt"] = app.now_iso()
        app.store.put("interpretations", item)
    app.scheduler.request(item["verseId"])
    return item


def delete_interpretation(app: "App", user: dict, item_id: str) -> dict:
    with app.lock:
        item = _get(app, "interpretations", item_id, "Interpretation")
        _own(item, user)
        if item.get("deleted"):
            return {"id": item_id, "deleted": "soft"}
        if app.store.query("interpretations", "replyTo", item_id):
            item.update({"deleted": True, "bodyMd": blank(item["bodyMd"]), "updatedAt": app.now_iso()})
            app.store.put("interpretations", item)
            result = {"id": item_id, "deleted": "soft"}
        else:
            _remove(app, "interpretations", item_id)
            _collect_reply_chain(app, item)
            result = {"id": item_id, "deleted": "hard"}
    app.scheduler.request(item["verseId"])
    return result


# ------------------------------------------------- removal and collection

def _remove(app: "App", table: str, item_id: str) -> None:
    """Hard delete: the record and, for a verse or interpretation, the votes on it."""
    app.store.delete(table, item_id)
    kind = {"verses": "verse", "interpretations": "interpretation"}.get(table)
    if kind:
        for vote in app.store.query("votes", "targetKey", f"{kind}:{item_id}"):
            app.store.delete("votes", vote["id"])


def _collect_reply_chain(app: "App", item: dict) -> None:
    """After a hard delete, soft-deleted parents that lost their last reply go too."""
    parent_id = item.get("replyTo")
    while parent_id:
        parent = app.store.get("interpretations", parent_id)
        if not parent or not parent.get("deleted") or app.store.query("interpretations", "replyTo", parent_id):
            break
        _remove(app, "interpretations", parent_id)
        parent_id = parent.get("replyTo")


def _collect_question(app: "App", question_id: str) -> None:
    question = app.store.get("questions", question_id)
    if question and question.get("deleted") and not app.store.query("arguments", "questionId", question_id):
        _remove(app, "questions", question_id)


# -------------------------------------------------------------------- votes

def put_vote(app: "App", user: dict, verse_id: str, body: dict) -> dict:
    """One vote per user and verse; null removes it. Voting on your own verse is
    allowed: the vote is about what the verse teaches, not about its author."""
    if "value" not in body:
        raise validation('"value" is required (1, -1, 0 or null)', "value")
    value = body["value"]
    if value is not None and (isinstance(value, bool) or value not in (1, -1, 0)):
        raise validation('"value" must be 1, -1, 0 or null', "value")
    with app.lock:
        verse = _get(app, "verses", verse_id, "Verse")
        vote_id = f"verse:{verse_id}:{user['id']}"
        if value is None:
            app.store.delete("votes", vote_id)
        else:
            existing = app.store.get("votes", vote_id)
            now = app.now_iso()
            app.store.put("votes", {
                "id": vote_id,
                "targetKey": f"verse:{verse_id}",
                "userId": user["id"],
                "value": value,
                "createdAt": existing["createdAt"] if existing else now,
                "updatedAt": now,
            })
    return verse


def put_interpretation_vote(app: "App", user: dict, item_id: str, body: dict) -> dict:
    """+1 / −1 / null on an interpretation; not on your own, not on a deleted one.
    These votes only rank interpretations: no outcome, tally or AI input uses them."""
    if "value" not in body:
        raise validation('"value" is required (1, -1 or null)', "value")
    value = body["value"]
    if value is not None and (isinstance(value, bool) or value not in (1, -1)):
        raise validation('"value" must be 1, -1 or null for an interpretation', "value")
    with app.lock:
        item = _get(app, "interpretations", item_id, "Interpretation")
        _alive(item)
        if item["authorId"] == user["id"]:
            raise ApiError(403, "own_item", "You cannot rate your own interpretation")
        vote_id = f"interpretation:{item_id}:{user['id']}"
        if value is None:
            app.store.delete("votes", vote_id)
        else:
            existing = app.store.get("votes", vote_id)
            now = app.now_iso()
            app.store.put("votes", {
                "id": vote_id,
                "targetKey": f"interpretation:{item_id}",
                "userId": user["id"],
                "value": value,
                "createdAt": existing["createdAt"] if existing else now,
                "updatedAt": now,
            })
    return item


# --------------------------------------------------------------- verse tags

def verse_tags(app: "App", book: str, chapter: int, view) -> List[dict]:
    """One tag per canonical verse key of `book chapter` covered by each ArgumentVerse."""
    tags = []
    cache = {}

    def record(table, item_id):
        if (table, item_id) not in cache:
            cache[(table, item_id)] = app.store.get(table, item_id)
        return cache[(table, item_id)]

    for verse in app.store.scan("verses"):
        numbers = refmod.verses_in_chapter(verse["ref"], book, chapter, app.counts)
        if not numbers:
            continue
        question = record("questions", verse["questionId"])
        argument = record("arguments", verse["argumentId"])
        if question is None or argument is None:
            continue
        rendered = view.verse(verse)
        for number in numbers:
            tags.append({
                "key": f"{book}.{chapter}.{number}",
                "questionId": question["id"],
                "questionTitle": question["title"],
                "argumentId": argument["id"],
                "argumentTitle": argument["title"],
                "verseId": verse["id"],
                "users": rendered["users"]["outcome"],
                "ai": rendered["ai"]["outcome"],
            })
    return sorted(tags, key=lambda t: (refmod.sort_key(t["key"]), t["questionId"], t["argumentId"], t["verseId"]))
