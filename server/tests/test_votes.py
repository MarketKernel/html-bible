"""Votes on verses, outcomes in context, tallies, and the endpoints that are gone."""

from __future__ import annotations

import unittest

from server.core import ratings
from server.tests.helpers import A1, A2, A3, Q1, V, new_client, teardown


class VotesTest(unittest.TestCase):
    def setUp(self):
        self.client = new_client()

    def tearDown(self):
        teardown(self.client)

    def vote(self, who, verse, value):
        return self.client.call("PUT", f"/v1/votes/verse/{verse}", who, {"value": value})

    def test_vote_change_remove(self):
        # V05 (COL 2:9): elena +1, sarah +1.
        status, body = self.vote("david", V(5), -1)
        self.assertEqual(status, 200)
        self.assertEqual(body["votes"], {"pro": 2, "con": 1, "none": 0, "mine": -1})
        self.assertEqual(body["users"], {"outcome": 1})
        _, body = self.vote("david", V(5), 0)                 # changed, not added
        self.assertEqual(body["votes"], {"pro": 2, "con": 0, "none": 1, "mine": 0})
        _, body = self.vote("david", V(5), None)              # removed
        self.assertEqual(body["votes"], {"pro": 2, "con": 0, "none": 0, "mine": None})
        self.assertEqual(self.vote("david", V(5), None)[0], 200)

    def test_own_verse_allowed(self):
        # V01 was added by Anna; she may vote on it.
        status, body = self.vote("anna", V(1), -1)
        self.assertEqual(status, 200)
        self.assertEqual(body["votes"]["mine"], -1)

    def test_response_context_and_tie(self):
        # V02 (JHN 10:30) is tied 2:2 → undecided; one more vote decides it.
        _, before = self.client.call("GET", f"/v1/verses/{V(2)}/rating")
        self.assertIsNone(before["users"]["outcome"])
        status, body = self.vote("mikhail", V(2), 1)
        self.assertEqual(set(body), {"votes", "users", "argument", "question"})
        self.assertEqual(body["users"], {"outcome": 1})
        self.assertEqual(body["argument"]["id"], A1)
        self.assertEqual(body["question"]["id"], Q1)
        a_before, a_after = before["argument"]["tally"]["users"], body["argument"]["tally"]["users"]
        self.assertEqual((a_after["pro"], a_after["open"]), (a_before["pro"] + 1, a_before["open"] - 1))
        q_after = body["question"]["tally"]["users"]
        self.assertEqual(q_after["pro"], before["question"]["tally"]["users"]["pro"] + 1)

    def test_tallies_sum(self):
        _, full = self.client.call("GET", f"/v1/questions/{Q1}")
        arguments = {a["id"]: a for a in full["arguments"]}
        for aid in (A1, A2, A3):
            own = [v for v in full["verses"] if v["argumentId"] == aid]
            self.assertEqual(arguments[aid]["tally"], ratings.tallies(own))
        self.assertEqual(full["question"]["tally"], ratings.add_tallies([a["tally"] for a in full["arguments"]]))
        self.assertEqual(full["question"]["tally"]["users"], {"pro": 7, "con": 6, "none": 1, "open": 3})
        _, listed = self.client.call("GET", "/v1/questions")
        self.assertEqual(listed["questions"][0]["tally"], full["question"]["tally"])
        self.assertEqual((listed["questions"][0]["argumentCount"], listed["questions"][0]["verseCount"]), (3, 17))

    def test_invalid(self):
        for value in (2, True, "1", 0.5):
            self.assertEqual(self.vote("elena", V(1), value)[0], 400, value)
        self.assertEqual(self.client.call("PUT", f"/v1/votes/verse/{V(1)}", "elena", {})[0], 400)
        self.assertEqual(self.vote("elena", "NOPE", 1)[0], 404)
        self.assertEqual(self.client.call("PUT", f"/v1/votes/verse/{V(1)}", body={"value": 1})[0], 401)

    def test_mine_only_with_token(self):
        _, anonymous = self.client.call("GET", f"/v1/questions/{Q1}")
        self.assertTrue(all("mine" not in v["votes"] for v in anonymous["verses"]))
        _, signed = self.client.call("GET", f"/v1/questions/{Q1}", "elena")
        mine = {v["id"]: v["votes"]["mine"] for v in signed["verses"]}
        self.assertEqual(mine[V(1)], 1)
        self.assertIsNone(mine[V(6)])

    def test_removed_endpoints(self):
        for method, path, body in (
            ("PUT", f"/v1/votes/point/{V(1)}", {"value": 1}),
            ("PUT", f"/v1/votes/argument/{A1}", {"value": 1}),
            ("PUT", f"/v1/votes/question/{Q1}", {"value": 1}),
            ("GET", f"/v1/arguments/{A1}/rating", None),
            ("POST", f"/v1/arguments/{A1}/points", {"lang": "en", "side": "pro", "bodyMd": "x"}),
            ("PATCH", "/v1/points/x", {"bodyMd": "x"}),
            ("DELETE", "/v1/points/x", None),
        ):
            status, out = self.client.call(method, path, "elena", body)
            self.assertEqual((status, out["error"]["code"]), (404, "not_found"), path)


if __name__ == "__main__":
    unittest.main()
