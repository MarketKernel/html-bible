"""Outcome and tally rules (Task.md §3), on plain data."""

from __future__ import annotations

import unittest

from server.core import ratings


class OutcomeTest(unittest.TestCase):
    def test_majority(self):
        self.assertEqual(ratings.outcome([1, 1, -1]), 1)
        self.assertEqual(ratings.outcome([-1, -1, 0, 1]), -1)
        self.assertEqual(ratings.outcome([0, 0, 1]), 0)
        self.assertEqual(ratings.outcome([1]), 1)

    def test_ties_and_no_votes_are_undecided(self):
        self.assertIsNone(ratings.outcome([]))
        self.assertIsNone(ratings.outcome([1, -1]))
        self.assertIsNone(ratings.outcome([1, 1, 0, 0, -1]))   # top two tie, third lower
        self.assertIsNone(ratings.outcome([1, -1, 0]))
        self.assertEqual(ratings.outcome([1, 1, -1, 0]), 1)      # only the top two matter

    def test_ai_outcome_uses_model_values(self):
        verdicts = [{"value": 1}, {"value": 1}]
        self.assertEqual(ratings.verse_ai(verdicts, "fresh"), {"outcome": 1, "status": "fresh", "verdicts": verdicts})
        self.assertIsNone(ratings.verse_ai([{"value": 1}, {"value": 0}], "fresh")["outcome"])
        self.assertEqual(ratings.verse_ai([], "none"), {"outcome": None, "status": "none", "verdicts": []})
        self.assertEqual(ratings.verse_ai(verdicts, "pending")["outcome"], 1)  # stale result still shown

    def test_verse_votes(self):
        self.assertEqual(ratings.verse_votes([1, 1, -1, 0], None, False), {"pro": 2, "con": 1, "none": 1})
        self.assertEqual(ratings.verse_votes([], None, True), {"pro": 0, "con": 0, "none": 0, "mine": None})
        self.assertEqual(ratings.verse_votes([0], 0, True)["mine"], 0)


class TallyTest(unittest.TestCase):
    def verse(self, users, ai, status="fresh"):
        return {"users": {"outcome": users}, "ai": {"outcome": ai, "status": status}}

    def test_tally(self):
        self.assertEqual(ratings.tally([1, 1, -1, 0, None, None]), {"pro": 2, "con": 1, "none": 1, "open": 2})
        self.assertEqual(ratings.tally([]), {"pro": 0, "con": 0, "none": 0, "open": 0})

    def test_tallies_and_status(self):
        verses = [self.verse(1, -1), self.verse(None, 0), self.verse(-1, None, "pending")]
        t = ratings.tallies(verses)
        self.assertEqual(t["users"], {"pro": 1, "con": 1, "none": 0, "open": 1})
        self.assertEqual(t["ai"], {"pro": 0, "con": 1, "none": 1, "open": 1})
        self.assertEqual(t["aiStatus"], "pending")
        self.assertEqual(ratings.tallies([self.verse(1, 1)])["aiStatus"], "fresh")
        self.assertEqual(ratings.tallies([])["aiStatus"], "none")

    def test_topic_is_sum_of_subtopics(self):
        a = ratings.tallies([self.verse(1, 1), self.verse(0, None)])
        b = ratings.tallies([self.verse(-1, -1, "pending")])
        empty = ratings.tallies([])
        whole = ratings.tallies([self.verse(1, 1), self.verse(0, None), self.verse(-1, -1, "pending")])
        self.assertEqual(ratings.add_tallies([a, b, empty]), whole)
        self.assertEqual(ratings.add_tallies([empty])["aiStatus"], "none")

    def test_lean(self):
        self.assertEqual(ratings.lean({"pro": 7, "con": 4, "none": 2, "open": 1}), 27)
        self.assertEqual(ratings.lean({"pro": 0, "con": 3, "none": 0, "open": 0}), -100)
        self.assertIsNone(ratings.lean({"pro": 0, "con": 0, "none": 5, "open": 1}))


if __name__ == "__main__":
    unittest.main()
