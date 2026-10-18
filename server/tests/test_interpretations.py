"""Interpretations: two columns per verse, replies, edit, soft delete."""

from __future__ import annotations

import unittest

from server.tests.helpers import Q1, T, V, new_client, teardown


def body(text="An interpretation", side="pro", lang="en", **extra):
    out = {"lang": lang, "side": side, "bodyMd": text}
    out.update(extra)
    return out


class InterpretationsTest(unittest.TestCase):
    def setUp(self):
        self.client = new_client()

    def tearDown(self):
        teardown(self.client)

    def add(self, who, verse, **kwargs):
        return self.client.call("POST", f"/v1/verses/{verse}/interpretations", who, body(**kwargs))

    def items(self):
        return {i["id"]: i for i in self.client.call("GET", f"/v1/questions/{Q1}")[1]["interpretations"]}

    def test_create(self):
        status, item = self.add("elena", V(6), text="Привет", side="con", lang="ru")
        self.assertEqual(status, 201)
        self.assertEqual(item["verseId"], V(6))
        self.assertEqual(item["side"], "con")
        self.assertEqual(item["bodyMd"], {"orig": "ru", "ru": "Привет", "en": "[auto-translated ru→en] Привет"})
        self.assertEqual(set(item), {"id", "verseId", "argumentId", "questionId", "side", "bodyMd", "author", "createdAt", "votes"})
        self.assertEqual(item["votes"], {"up": 0, "down": 0, "mine": None})

    def test_replies(self):
        status, item = self.add("elena", V(1), side="pro", replyTo=T(1))      # same side is fine
        self.assertEqual((status, item["replyTo"]), (201, T(1)))
        self.assertEqual(self.add("elena", V(1), side="con", replyTo=T(1))[0], 201)
        status, out = self.add("elena", V(2), replyTo=T(1))                   # another verse
        self.assertEqual((status, out["error"]["field"]), (400, "replyTo"))
        self.assertEqual(self.add("elena", V(1), replyTo="NOPE")[0], 400)

    def test_validation(self):
        for bad, field in ((body(side="maybe"), "side"), (body(text=""), "bodyMd"),
                           ({"side": "pro", "bodyMd": "x"}, "lang"), (body(text="x" * 5001), "bodyMd")):
            status, out = self.client.call("POST", f"/v1/verses/{V(1)}/interpretations", "elena", bad)
            self.assertEqual((status, out["error"]["field"]), (400, field))
        self.assertEqual(self.client.call("POST", "/v1/verses/NOPE/interpretations", "elena", body())[0], 404)

    def test_patch(self):
        status, item = self.client.call("PATCH", f"/v1/interpretations/{T(1)}", "anna",
                                        {"lang": "en", "bodyMd": "Edited"})
        self.assertEqual((status, item["bodyMd"]["en"], item["bodyMd"]["orig"]), (200, "Edited", "en"))
        self.assertIn("updatedAt", item)
        self.assertEqual(self.client.call("PATCH", f"/v1/interpretations/{T(1)}", "david",
                                          {"lang": "en", "bodyMd": "x"})[1]["error"]["code"], "forbidden")
        status, out = self.client.call("PATCH", f"/v1/interpretations/{T(1)}", "anna", {"side": "con"})
        self.assertEqual((status, out["error"]["field"]), (400, "side"))

    def test_soft_and_hard_delete(self):
        # T02 has a reply (T03): soft. T01 has none: hard.
        self.assertEqual(self.client.call("DELETE", f"/v1/interpretations/{T(2)}", "david")[1]["deleted"], "soft")
        self.assertEqual(self.client.call("DELETE", f"/v1/interpretations/{T(1)}", "anna")[1]["deleted"], "hard")
        items = self.items()
        self.assertNotIn(T(1), items)
        self.assertTrue(items[T(2)]["deleted"])
        self.assertEqual(items[T(2)]["bodyMd"], {"orig": "en", "ru": "", "en": ""})
        self.assertEqual(items[T(2)]["author"]["displayName"], "David")
        status, out = self.client.call("PATCH", f"/v1/interpretations/{T(2)}", "david", {"lang": "en", "bodyMd": "x"})
        self.assertEqual((status, out["error"]["code"]), (409, "deleted"))
        status, out = self.add("elena", V(1), replyTo=T(2))
        self.assertEqual((status, out["error"]["code"]), (409, "deleted"))
        # The reply goes → the soft-deleted parent goes with it.
        self.assertEqual(self.client.call("DELETE", f"/v1/interpretations/{T(3)}", "elena")[1]["deleted"], "hard")
        self.assertNotIn(T(2), self.items())

    def test_only_author_deletes(self):
        status, out = self.client.call("DELETE", f"/v1/interpretations/{T(1)}", "david")
        self.assertEqual((status, out["error"]["code"]), (403, "forbidden"))


if __name__ == "__main__":
    unittest.main()
