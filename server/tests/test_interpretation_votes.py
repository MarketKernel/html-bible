"""+ / − on interpretations: rules, ordering, and no effect on outcomes or the AI."""

from __future__ import annotations

import unittest

from server.tests.helpers import Q1, T, V, new_client, teardown


class InterpretationVotesTest(unittest.TestCase):
    def setUp(self):
        self.client = new_client()

    def tearDown(self):
        teardown(self.client)

    def vote(self, who, item, value):
        return self.client.call("PUT", f"/v1/votes/interpretation/{item}", who, {"value": value})

    def full(self, who=None):
        return self.client.call("GET", f"/v1/questions/{Q1}", who)[1]

    def test_vote_change_remove(self):
        # T01 (Anna's): seed elena +1, mikhail +1, david −1.
        status, body = self.vote("sarah", T(1), 1)
        self.assertEqual((status, body), (200, {"votes": {"up": 3, "down": 1, "mine": 1}}))
        self.assertEqual(self.vote("sarah", T(1), -1)[1], {"votes": {"up": 2, "down": 2, "mine": -1}})
        self.assertEqual(self.vote("sarah", T(1), None)[1], {"votes": {"up": 2, "down": 1, "mine": None}})
        self.assertEqual(self.vote("sarah", T(1), None)[0], 200)

    def test_rules(self):
        status, body = self.vote("anna", T(1), 1)
        self.assertEqual((status, body["error"]["code"]), (403, "own_item"))
        for value in (0, 2, True, "1"):
            status, body = self.vote("sarah", T(1), value)
            self.assertEqual((status, body["error"]["field"]), (400, "value"), value)
        self.assertEqual(self.client.call("PUT", f"/v1/votes/interpretation/{T(1)}", "sarah", {})[0], 400)
        self.assertEqual(self.vote("sarah", "NOPE", 1)[0], 404)
        self.assertEqual(self.client.call("PUT", f"/v1/votes/interpretation/{T(1)}", body={"value": 1})[0], 401)

    def test_deleted(self):
        self.client.call("DELETE", f"/v1/interpretations/{T(2)}", "david")       # soft: T03 replies
        status, body = self.vote("sarah", T(2), 1)
        self.assertEqual((status, body["error"]["code"]), (409, "deleted"))
        items = {i["id"]: i for i in self.full("mikhail")["interpretations"]}
        self.assertEqual(items[T(2)]["votes"], {"up": 0, "down": 0, "mine": None})   # hidden
        self.assertEqual(len(self.client.app.store.query("votes", "targetKey", f"interpretation:{T(2)}")), 3)
        # Hard delete removes the votes.
        self.client.call("DELETE", f"/v1/interpretations/{T(1)}", "anna")
        self.assertEqual(self.client.app.store.query("votes", "targetKey", f"interpretation:{T(1)}"), [])

    def test_shown_everywhere_with_mine(self):
        anonymous = {i["id"]: i for i in self.full()["interpretations"]}
        self.assertEqual(anonymous[T(3)]["votes"], {"up": 3, "down": 0})
        signed = {i["id"]: i for i in self.full("mikhail")["interpretations"]}
        self.assertEqual(signed[T(3)]["votes"], {"up": 3, "down": 0, "mine": 1})
        self.assertIsNone(signed[T(4)]["votes"]["mine"])
        status, item = self.client.call("PATCH", f"/v1/interpretations/{T(3)}", "elena", {"lang": "en", "bodyMd": "Edited"})
        self.assertEqual(item["votes"], {"up": 3, "down": 0, "mine": None})

    def test_ordering(self):
        items = self.full()["interpretations"]
        # V01 pro: T03 (score 3) before T01 (score 1), although T01 is older.
        v1_pro = [i["id"] for i in items if i["verseId"] == V(1) and i["side"] == "pro"]
        self.assertEqual(v1_pro, [T(3), T(1)])
        # Grouped by verse in the verses' order, pro before con.
        verse_order = [v["id"] for v in self.full()["verses"]]
        keys = [(verse_order.index(i["verseId"]), 0 if i["side"] == "pro" else 1) for i in items]
        self.assertEqual(keys, sorted(keys))
        for (verse, side) in set((i["verseId"], i["side"]) for i in items):
            group = [i for i in items if i["verseId"] == verse and i["side"] == side]
            scores = [(-(i["votes"]["up"] - i["votes"]["down"]), i["createdAt"]) for i in group]
            self.assertEqual(scores, sorted(scores))
        # A vote can reorder: two −1 on T03 drops it below T01.
        self.vote("david", T(3), -1)
        self.vote("elena", T(1), None)
        self.vote("sarah", T(3), -1)  # changes sarah's +1 to −1: T03 = 2 up, 2 down → 0; T01 = 1 up, 1 down → 0
        v1_pro = [i["id"] for i in self.full()["interpretations"] if i["verseId"] == V(1) and i["side"] == "pro"]
        self.assertEqual(v1_pro, [T(1), T(3)])   # equal score → older first

    def test_no_effect_on_outcomes_or_ai(self):
        before = self.client.call("GET", f"/v1/verses/{V(1)}/rating")[1]
        runs = self.client.app.scheduler.runs
        self.vote("sarah", T(1), -1)
        self.vote("sarah", T(2), -1)
        after = self.client.call("GET", f"/v1/verses/{V(1)}/rating")[1]
        self.assertEqual(after, before)
        self.assertEqual(self.client.app.scheduler.runs, runs)


if __name__ == "__main__":
    unittest.main()
