"""Stored records → API JSON (field names exactly as docs/api.md and src/core/api-types.ts).

Outcomes and tallies are computed on read, so they can never drift from the
votes and verdicts they come from.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

from . import ratings
from .refs import sort_key

if TYPE_CHECKING:
    from .app import App


def user_view(user: dict) -> dict:
    return {
        "id": user["id"],
        "provider": user["provider"],
        "displayName": user["displayName"],
        "createdAt": user["createdAt"],
    }


def verse_order(verse: dict) -> Tuple:
    """Canonical Bible order: book (GEN…REV), chapter, verse, then where the range ends."""
    return sort_key(verse["ref"]["from"]), sort_key(verse["ref"]["to"]), verse["argumentId"], verse["id"]


def _stamps(record: dict, out: dict) -> dict:
    if record.get("updatedAt"):
        out["updatedAt"] = record["updatedAt"]
    if record.get("deleted"):
        out["deleted"] = True
    return out


class View:
    """Renders for one viewer (`viewer_id` None = anonymous, no `votes.mine`)."""

    def __init__(self, app: "App", viewer_id: Optional[str]):
        self.app = app
        self.viewer_id = viewer_id
        self._authors: Dict[str, dict] = {}

    def author(self, user_id: str) -> dict:
        if user_id not in self._authors:
            user = self.app.store.get("users", user_id)
            self._authors[user_id] = {"id": user_id, "displayName": user["displayName"] if user else "—"}
        return dict(self._authors[user_id])

    # --- verses ---

    def votes(self, verse_id: str) -> List[dict]:
        return self.app.store.query("votes", "targetKey", f"verse:{verse_id}")

    def verse(self, verse: dict) -> dict:
        votes = self.votes(verse["id"])
        values = [v["value"] for v in votes]
        mine = next((v["value"] for v in votes if v["userId"] == self.viewer_id), None)
        ai = verse.get("ai") or {}
        return {
            "id": verse["id"],
            "argumentId": verse["argumentId"],
            "questionId": verse["questionId"],
            "ref": verse["ref"],
            "author": self.author(verse["authorId"]),
            "createdAt": verse["createdAt"],
            "votes": ratings.verse_votes(values, mine, self.viewer_id is not None),
            "users": {"outcome": ratings.outcome(values)},
            "ai": ratings.verse_ai(ai.get("verdicts", []), ai.get("status", "none")),
        }

    def verses_of(self, field: str, value: str) -> List[dict]:
        return sorted(self.app.store.query("verses", field, value), key=verse_order)

    def interpretation(self, item: dict) -> dict:
        out = {
            "id": item["id"],
            "verseId": item["verseId"],
            "argumentId": item["argumentId"],
            "questionId": item["questionId"],
            "side": item["side"],
            "bodyMd": item["bodyMd"],
        }
        if item.get("replyTo"):
            out["replyTo"] = item["replyTo"]
        out["author"] = self.author(item["authorId"])
        out["createdAt"] = item["createdAt"]
        _stamps(item, out)
        out["votes"] = self.interpretation_votes(item)
        return out

    def interpretation_votes(self, item: dict) -> dict:
        """+ / − counts. A soft-deleted interpretation keeps its votes stored but
        shows zeros (its text is gone, so the counts would mean nothing)."""
        viewer = self.viewer_id is not None
        if item.get("deleted"):
            return ratings.updown_votes([], None, viewer)
        votes = self.app.store.query("votes", "targetKey", f"interpretation:{item['id']}")
        mine = next((v["value"] for v in votes if v["userId"] == self.viewer_id), None)
        return ratings.updown_votes([v["value"] for v in votes], mine, viewer)

    # --- tallies ---

    def argument_tally(self, argument_id: str, rendered: Optional[List[dict]] = None) -> dict:
        if rendered is None:
            rendered = [self.verse(v) for v in self.verses_of("argumentId", argument_id)]
        return ratings.tallies(rendered)

    def question_tally(self, question_id: str, rendered: Optional[List[dict]] = None) -> dict:
        """The sum over the topic's subtopics = the tally of all its verses."""
        if rendered is None:
            rendered = [self.verse(v) for v in self.verses_of("questionId", question_id)]
        return ratings.tallies(rendered)

    def context(self, verse: dict) -> dict:
        """What changes along with one verse: its subtopic's and topic's tallies."""
        return {
            "argument": {"id": verse["argumentId"], "tally": self.argument_tally(verse["argumentId"])},
            "question": {"id": verse["questionId"], "tally": self.question_tally(verse["questionId"])},
        }

    # --- entities ---

    def argument(self, argument: dict, rendered_verses: Optional[List[dict]] = None) -> dict:
        out = {
            "id": argument["id"],
            "questionId": argument["questionId"],
            "title": argument["title"],
            "summaryMd": argument["summaryMd"],
            "author": self.author(argument["authorId"]),
            "createdAt": argument["createdAt"],
        }
        _stamps(argument, out)
        out["tally"] = self.argument_tally(argument["id"], rendered_verses)
        return out

    def question(self, question: dict, with_counts: bool = False, rendered_verses: Optional[List[dict]] = None) -> dict:
        out = {
            "id": question["id"],
            "title": question["title"],
            "summaryMd": question["summaryMd"],
            "sides": question["sides"],
            "tags": question["tags"],
            "author": self.author(question["authorId"]),
            "createdAt": question["createdAt"],
        }
        _stamps(question, out)
        if rendered_verses is None:
            rendered_verses = [self.verse(v) for v in self.verses_of("questionId", question["id"])]
        out["tally"] = self.question_tally(question["id"], rendered_verses)
        if with_counts:
            arguments = self.app.store.query("arguments", "questionId", question["id"])
            out["argumentCount"] = sum(1 for a in arguments if not a.get("deleted"))
            out["verseCount"] = len(rendered_verses)
        return out

    def question_full(self, question: dict) -> dict:
        """QuestionFull: arguments by createdAt, verses in canonical order; interpretations
        grouped by verse (in the verses' order) and side (pro, con), and within a
        verse and side by score (up − down) descending, then createdAt ascending."""
        arguments = sorted(self.app.store.query("arguments", "questionId", question["id"]),
                           key=lambda a: (a["createdAt"], a["id"]))
        verses = [self.verse(v) for v in self.verses_of("questionId", question["id"])]
        verse_index = {v["id"]: n for n, v in enumerate(verses)}
        rendered = [self.interpretation(i) for i in self.app.store.query("interpretations", "questionId", question["id"])]
        rendered.sort(key=lambda i: (
            verse_index.get(i["verseId"], len(verse_index)), 0 if i["side"] == "pro" else 1,
            -(i["votes"]["up"] - i["votes"]["down"]), i["createdAt"], i["id"],
        ))
        return {
            "question": self.question(question, rendered_verses=verses),
            "arguments": [self.argument(a, [v for v in verses if v["argumentId"] == a["id"]]) for a in arguments],
            "verses": verses,
            "interpretations": rendered,
        }

    def verse_rating(self, verse: dict) -> dict:
        rendered = self.verse(verse)
        out = {"votes": rendered["votes"], "users": rendered["users"], "ai": rendered["ai"]}
        out.update(self.context(verse))
        return out

    def vote_result(self, verse: dict) -> dict:
        rendered = self.verse(verse)
        out = {"votes": rendered["votes"], "users": rendered["users"]}
        out.update(self.context(verse))
        return out
