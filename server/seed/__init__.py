"""Demo data: the balanced "Trinity" topic (Task.md §4), loaded into an empty store.

Three subtopics, verses both sides cite, interpretations in both columns and
votes that give every kind of outcome (pro, con, not relevant, undecided).
Seed users get the same ids the auth stub gives on sign-in ("Anna" via
Google, "David" via Microsoft, "Elena" via Apple, …), so the client can act
as a seed author.
"""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING

from ..auth_stub.tokens import stub_sub
from ..core import refs

if TYPE_CHECKING:
    from ..core.app import App

SEED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trinity.json")
SEED_VERSION = 3


def read_seed() -> dict:
    with open(SEED_FILE, "r", encoding="utf-8") as fh:
        return json.load(fh)


def seed_user_ids(data: dict) -> dict:
    return {u["key"]: stub_sub(u["provider"], u["displayName"]) for u in data["users"]}


def seeded(app: "App") -> bool:
    """True when the store holds data of the current seed version (an older
    version means an older data model: local_server wipes and reseeds it)."""
    meta = app.store.get("meta", "seed")
    return meta is not None and meta.get("version") == SEED_VERSION


def load_seed(app: "App") -> None:
    data = read_seed()
    users = seed_user_ids(data)
    store = app.store
    with app.lock, store.batch():
        for user in data["users"]:
            store.put("users", {
                "id": users[user["key"]],
                "provider": user["provider"],
                "displayName": user["displayName"],
                "createdAt": user["createdAt"],
            })
        for question in data["questions"]:
            store.put("questions", {
                "id": question["id"],
                "title": question["title"],
                "summaryMd": question["summaryMd"],
                "sides": question["sides"],
                "tags": question["tags"],
                "authorId": users[question["author"]],
                "createdAt": question["createdAt"],
            })
        for argument in data["arguments"]:
            store.put("arguments", {
                "id": argument["id"],
                "questionId": argument["questionId"],
                "title": argument["title"],
                "summaryMd": argument["summaryMd"],
                "authorId": users[argument["author"]],
                "createdAt": argument["createdAt"],
            })
        question_of = {a["id"]: a["questionId"] for a in data["arguments"]}
        verse_of = {}
        for verse in data["verses"]:
            record = {
                "id": verse["id"],
                "argumentId": verse["argumentId"],
                "questionId": question_of[verse["argumentId"]],
                # Validated like user input: a bad seed reference fails loudly.
                "ref": refs.parse_range(verse["ref"], app.counts, f"seed {verse['id']}"),
                "authorId": users[verse["author"]],
                "createdAt": verse["createdAt"],
                "ai": {"status": "none", "verdicts": []},
            }
            verse_of[verse["id"]] = record
            store.put("verses", record)
        for item in data["interpretations"]:
            verse = verse_of[item["verseId"]]
            record = {
                "id": item["id"],
                "verseId": item["verseId"],
                "argumentId": verse["argumentId"],
                "questionId": verse["questionId"],
                "side": item["side"],
                "bodyMd": item["bodyMd"],
                "authorId": users[item["author"]],
                "createdAt": item["createdAt"],
            }
            if item.get("replyTo"):
                record["replyTo"] = item["replyTo"]
            store.put("interpretations", record)
        for verse_id, ballots in data["votes"].items():
            for user_key, value in ballots.items():
                store.put("votes", {
                    "id": f"verse:{verse_id}:{users[user_key]}",
                    "targetKey": f"verse:{verse_id}",
                    "userId": users[user_key],
                    "value": value,
                    "createdAt": data["evaluatedAt"],
                    "updatedAt": data["evaluatedAt"],
                })
        for item_id, ballots in data.get("interpretationVotes", {}).items():
            for user_key, value in ballots.items():
                store.put("votes", {
                    "id": f"interpretation:{item_id}:{users[user_key]}",
                    "targetKey": f"interpretation:{item_id}",
                    "userId": users[user_key],
                    "value": value,
                    "createdAt": data["evaluatedAt"],
                    "updatedAt": data["evaluatedAt"],
                })
        # Initial evaluation at a fixed time, so seed outcomes are reproducible.
        for verse in data["verses"]:
            app.scheduler.run(verse["id"], at=data["evaluatedAt"])
        store.put("meta", {"id": "seed", "version": SEED_VERSION})
