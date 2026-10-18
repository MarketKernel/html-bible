"""The demo topic: balanced, canonical, bilingual, voted, evaluated."""

from __future__ import annotations

import unittest
from collections import Counter

from server.auth_stub.tokens import stub_sub
from server.core import refs
from server.core.books import VerseCounts
from server.core.config import DEFAULT_COUNTS_PATH
from server.seed import read_seed, seed_user_ids
from server.tests.helpers import Q1, new_client, teardown


class SeedTest(unittest.TestCase):
    def setUp(self):
        self.data = read_seed()
        self.client = new_client()

    def tearDown(self):
        teardown(self.client)

    def test_shape(self):
        self.assertEqual(len(self.data["questions"]), 1)
        self.assertEqual(len(self.data["arguments"]), 3)
        per_argument = Counter(v["argumentId"] for v in self.data["verses"])
        for argument in self.data["arguments"]:
            self.assertTrue(5 <= per_argument[argument["id"]] <= 7)
        sides = Counter((i["verseId"], i["side"]) for i in self.data["interpretations"])
        both = [v for v in self.data["verses"] if sides[(v["id"], "pro")] and sides[(v["id"], "con")]]
        self.assertGreaterEqual(len(both), len(self.data["verses"]) - 2)

    def test_texts_are_bilingual(self):
        def check(text):
            self.assertIn(text["orig"], ("ru", "en"))
            self.assertTrue(text["ru"].strip() and text["en"].strip())
            self.assertNotIn("auto-translated", text["ru"] + text["en"])
        for item in self.data["questions"] + self.data["arguments"]:
            check(item["title"])
            check(item["summaryMd"])
        for item in self.data["interpretations"]:
            check(item["bodyMd"])
        self.assertEqual({i["bodyMd"]["orig"] for i in self.data["interpretations"]}, {"ru", "en"})

    def test_refs_are_canonical_and_unique(self):
        counts = VerseCounts(DEFAULT_COUNTS_PATH)   # the real KJV counts when the file exists
        seen = set()
        for verse in self.data["verses"]:
            self.assertEqual(refs.parse_range(verse["ref"], counts), verse["ref"])
            key = (verse["argumentId"], verse["ref"]["from"], verse["ref"]["to"])
            self.assertNotIn(key, seen)
            seen.add(key)

    def test_replies_stay_on_the_verse(self):
        items = {i["id"]: i for i in self.data["interpretations"]}
        for item in items.values():
            if item.get("replyTo"):
                self.assertEqual(items[item["replyTo"]]["verseId"], item["verseId"])

    def test_interpretation_votes_are_lawful(self):
        authors = {i["id"]: i["author"] for i in self.data["interpretations"]}
        self.assertGreaterEqual(len(self.data["interpretationVotes"]), 5)
        for item_id, ballots in self.data["interpretationVotes"].items():
            self.assertNotIn(authors[item_id], ballots, item_id)
            self.assertTrue(set(ballots.values()) <= {1, -1})

    def test_users(self):
        self.assertEqual(seed_user_ids(self.data)["anna"], stub_sub("google", "Anna"))

    def test_outcomes_cover_every_case(self):
        _, full = self.client.call("GET", f"/v1/questions/{Q1}")
        outcomes = Counter(v["users"]["outcome"] for v in full["verses"])
        for value in (1, -1, 0, None):
            self.assertGreater(outcomes[value], 0, value)
        self.assertEqual(full["question"]["tally"]["aiStatus"], "fresh")
        for verse in full["verses"]:
            self.assertEqual(verse["ai"]["status"], "fresh")
            self.assertEqual(len(verse["ai"]["verdicts"]), 2)


if __name__ == "__main__":
    unittest.main()
