"""Verses ("stones"): canonical order, uniqueness, validation, delete rules."""

from __future__ import annotations

import unittest

from server.tests.helpers import A1, A2, Q1, V, new_client, teardown


def ref(start, end=None):
    return {"ref": {"from": start, "to": end or start}}


class VersesTest(unittest.TestCase):
    def setUp(self):
        self.client = new_client()
        _, self.question = self.client.call("POST", "/v1/questions", "elena", {"lang": "en", "title": "Q"})
        _, self.argument = self.client.call("POST", f"/v1/questions/{self.question['id']}/arguments", "elena",
                                            {"lang": "en", "title": "A"})
        self.aid = self.argument["id"]

    def tearDown(self):
        teardown(self.client)

    def add(self, who, start, end=None, argument=None):
        return self.client.call("POST", f"/v1/arguments/{argument or self.aid}/verses", who, ref(start, end))

    def full(self, qid=None):
        return self.client.call("GET", f"/v1/questions/{qid or self.question['id']}")[1]

    def test_canonical_order(self):
        for start, end in (("REV.22.21", None), ("JHN.3.16", "JHN.3.18"), ("GEN.1.1", None), ("JHN.3.16", None),
                           ("JHN.10.30", None), ("1CO.8.6", None), ("JHN.3.2", None), ("PSA.23.1", None)):
            status, body = self.add("anna", start, end)
            self.assertEqual(status, 201, body)
        order = [(v["ref"]["from"], v["ref"]["to"]) for v in self.full()["verses"]]
        self.assertEqual(order, [
            ("GEN.1.1", "GEN.1.1"), ("PSA.23.1", "PSA.23.1"), ("JHN.3.2", "JHN.3.2"),
            ("JHN.3.16", "JHN.3.16"), ("JHN.3.16", "JHN.3.18"), ("JHN.10.30", "JHN.10.30"),
            ("1CO.8.6", "1CO.8.6"), ("REV.22.21", "REV.22.21"),
        ])
        _, listed = self.client.call("GET", "/v1/questions")
        mine = next(q for q in listed["questions"] if q["id"] == self.question["id"])
        self.assertEqual(mine["verseCount"], 8)
        self.assertNotIn("verseCount", self.full()["question"])

    def test_seed_order(self):
        keys = [v["ref"]["from"] for v in self.full(Q1)["verses"] if v["argumentId"] == A1]
        self.assertEqual(keys, ["MRK.13.32", "JHN.1.1", "JHN.10.30", "JHN.14.28", "JHN.20.28", "PHP.2.6", "COL.2.9"])

    def test_duplicate_returns_existing_id(self):
        _, first = self.add("anna", "JHN.1.1")
        status, body = self.add("david", "JHN.1.1")
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "duplicate_verse")
        self.assertEqual(body["error"]["id"], first["id"])
        # A different range or another subtopic is not a duplicate.
        self.assertEqual(self.add("david", "JHN.1.1", "JHN.1.2")[0], 201)
        self.assertEqual(self.add("david", "JHN.1.1", argument=A2)[0], 201)

    def test_new_verse_shape(self):
        status, verse = self.add("anna", "JHN.3.16")
        self.assertEqual(status, 201)
        self.assertEqual(set(verse), {"id", "argumentId", "questionId", "ref", "author", "createdAt", "votes", "users", "ai"})
        self.assertEqual(verse["votes"], {"pro": 0, "con": 0, "none": 0, "mine": None})
        self.assertEqual(verse["users"], {"outcome": None})
        self.assertEqual(verse["ai"]["status"], "fresh")       # eval-delay 0
        self.assertEqual(verse["ai"]["outcome"], 0)            # no interpretations: not relevant
        self.assertEqual({v["confidence"] for v in verse["ai"]["verdicts"]}, {0.3})

    def test_validation(self):
        cases = [
            ({"ref": {"from": "TOB.1.1", "to": "TOB.1.1"}}, 400, "noncanonical_ref"),
            ({"ref": {"from": "JHN.3.18", "to": "JHN.3.16"}}, 400, "invalid_ref"),
            ({"ref": {"from": "JHN.3.16", "to": "ACT.1.1"}}, 400, "invalid_ref"),
            ({"ref": "JHN.3.16"}, 400, "invalid_ref"),
            ({}, 400, "validation_error"),
        ]
        for body, status, code in cases:
            got, out = self.client.call("POST", f"/v1/arguments/{self.aid}/verses", "anna", body)
            self.assertEqual((got, out["error"]["code"]), (status, code), body)
        self.assertEqual(self.client.call("POST", f"/v1/arguments/{self.aid}/verses", body=ref("JHN.1.1"))[0], 401)
        self.assertEqual(self.client.call("POST", "/v1/arguments/NOPE/verses", "anna", ref("JHN.1.1"))[0], 404)

    def test_delete_rules(self):
        _, verse = self.add("anna", "JHN.1.1")
        vid = verse["id"]
        status, body = self.client.call("DELETE", f"/v1/verses/{vid}", "david")
        self.assertEqual((status, body["error"]["code"]), (403, "forbidden"))
        # Her own vote does not block; somebody else's does.
        self.client.call("PUT", f"/v1/votes/verse/{vid}", "anna", {"value": 1})
        self.client.call("PUT", f"/v1/votes/verse/{vid}", "david", {"value": -1})
        status, body = self.client.call("DELETE", f"/v1/verses/{vid}", "anna")
        self.assertEqual((status, body["error"]["code"]), (409, "in_use"))
        self.client.call("PUT", f"/v1/votes/verse/{vid}", "david", {"value": None})
        self.assertEqual(self.client.call("DELETE", f"/v1/verses/{vid}", "anna"), (200, {"id": vid, "deleted": "hard"}))
        self.assertEqual(self.client.app.store.query("votes", "targetKey", f"verse:{vid}"), [])
        self.assertEqual(self.client.call("GET", f"/v1/verses/{vid}/rating")[0], 404)

    def test_delete_blocked_by_interpretations(self):
        status, body = self.client.call("DELETE", f"/v1/verses/{V(5)}", "anna")   # seed: votes and interpretations
        self.assertEqual((status, body["error"]["code"]), (409, "in_use"))
        _, verse = self.add("anna", "JHN.1.1")
        self.client.call("POST", f"/v1/verses/{verse['id']}/interpretations", "anna",
                         {"lang": "en", "side": "pro", "bodyMd": "Mine"})
        self.assertEqual(self.client.call("DELETE", f"/v1/verses/{verse['id']}", "anna")[0], 409)

    def test_deleted_argument(self):
        _, verse = self.add("elena", "JHN.1.1")
        self.assertEqual(self.client.call("DELETE", f"/v1/arguments/{self.aid}", "elena")[1]["deleted"], "soft")
        status, body = self.add("anna", "JHN.1.2")
        self.assertEqual((status, body["error"]["code"]), (409, "deleted"))
        # Removing its last verse removes the soft-deleted argument (and then the soft-deleted question).
        self.client.call("DELETE", f"/v1/questions/{self.question['id']}", "elena")
        self.assertEqual(self.client.call("DELETE", f"/v1/verses/{verse['id']}", "elena")[0], 200)
        self.assertEqual(self.client.call("GET", f"/v1/questions/{self.question['id']}")[0], 404)

    def test_empty_argument_hard_delete(self):
        self.assertEqual(self.client.call("DELETE", f"/v1/arguments/{self.aid}", "elena")[1]["deleted"], "hard")


if __name__ == "__main__":
    unittest.main()
