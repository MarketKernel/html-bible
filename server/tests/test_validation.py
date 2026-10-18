"""Input validation: canonical references, limits, language, moderation."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from server.core import refs
from server.core.books import CANONICAL_BOOKS, VerseCounts, normalize_counts
from server.core.errors import ApiError
from server.tests.helpers import A2, Q1, V, new_client, teardown


class RefsTest(unittest.TestCase):
    def test_66_books(self):
        self.assertEqual(len(CANONICAL_BOOKS), 66)
        self.assertEqual((CANONICAL_BOOKS[0], CANONICAL_BOOKS[-1]), ("GEN", "REV"))

    def test_parse_range(self):
        self.assertEqual(refs.parse_range({"from": "JHN.3.16", "to": "JHN.3.18"}), {"from": "JHN.3.16", "to": "JHN.3.18"})
        self.assertEqual(refs.parse_range({"from": "JHN.3.36", "to": "JHN.4.2"})["to"], "JHN.4.2")

    def test_refused(self):
        cases = {
            ("TOB.1.1", "TOB.1.1"): "noncanonical_ref",
            ("1MA.2.3", "1MA.2.3"): "noncanonical_ref",
            ("XYZ.1.1", "XYZ.1.1"): "invalid_ref",
            ("JHN.0.1", "JHN.0.1"): "invalid_ref",
            ("JHN.3.0", "JHN.3.0"): "invalid_ref",
            ("JHN.03.16", "JHN.03.16"): "invalid_ref",
            ("jhn.3.16", "jhn.3.16"): "invalid_ref",
            ("JHN.3.18", "JHN.3.16"): "invalid_ref",
            ("JHN.3.16", "ACT.1.1"): "invalid_ref",
        }
        for (start, end), code in cases.items():
            with self.subTest(start=start, end=end):
                with self.assertRaises(ApiError) as ctx:
                    refs.parse_range({"from": start, "to": end})
                self.assertEqual((ctx.exception.status, ctx.exception.code), (400, code))
        with self.assertRaises(ApiError):
            refs.parse_range({"from": "JHN.3.16"})

    def test_counts_bound_chapters_and_verses_when_present(self):
        tmp = tempfile.mkdtemp()
        try:
            path = os.path.join(tmp, "kjv-counts.json")
            with open(path, "w") as fh:
                json.dump({"JHN": [51, 25, 36]}, fh)
            counts = VerseCounts(path)
            self.assertEqual(refs.parse_range({"from": "JHN.3.36", "to": "JHN.3.36"}, counts)["from"], "JHN.3.36")
            for key in ("JHN.3.37", "JHN.4.1"):
                with self.assertRaises(ApiError):
                    refs.parse_range({"from": key, "to": key}, counts)
            # Books missing from the file are only checked for ≥ 1.
            refs.parse_range({"from": "REV.99.99", "to": "REV.99.99"}, counts)
        finally:
            shutil.rmtree(tmp)

    def test_counts_absent_means_only_positive(self):
        counts = VerseCounts("/nonexistent/kjv-counts.json")
        self.assertIsNone(counts.get())
        refs.parse_range({"from": "JHN.200.1", "to": "JHN.200.1"}, counts)

    def test_counts_shapes(self):
        expected = {"GEN": [31, 25]}
        for shape in (
            {"GEN": [31, 25]},
            {"books": {"GEN": [31, 25]}},
            [{"id": "GEN", "chapters": [31, 25]}],
            {"books": [{"book": "GEN", "chapters": [{"verses": 31}, {"verses": 25}]}]},
            {"GEN": {"chapters": [31, 25]}, "TOB": [1]},
        ):
            self.assertEqual(normalize_counts(shape), expected)
        with self.assertRaises(ValueError):
            normalize_counts({"nothing": 1})


class ApiValidationTest(unittest.TestCase):
    def setUp(self):
        self.client = new_client()

    def tearDown(self):
        teardown(self.client)

    def add_verse(self, start, end=None):
        return self.client.call("POST", f"/v1/arguments/{A2}/verses", "elena",
                                {"ref": {"from": start, "to": end or start}})

    def test_noncanonical_verses(self):
        for book in ("TOB", "JDT", "WIS", "SIR", "LJE", "BAR", "1MA", "2MA", "3MA", "1ES", "2ES"):
            status, body = self.add_verse(f"{book}.1.1", f"{book}.1.2")
            self.assertEqual((status, body["error"]["code"]), (400, "noncanonical_ref"), book)
            self.assertEqual(body["error"]["field"], "ref.from")
        _, full = self.client.call("GET", f"/v1/questions/{Q1}")
        self.assertEqual(len(full["verses"]), 17)   # nothing was saved

    def test_bad_json_and_limits(self):
        status, _, body = self.client.raw("POST", "/v1/questions", "elena",
                                          headers={"Content-Type": "application/json"})
        self.assertEqual((status, body["error"]["code"]), (400, "bad_request"))
        status, body = self.client.call("POST", "/v1/questions", "elena", {"lang": "de", "title": "x"})
        self.assertEqual(body["error"]["field"], "lang")
        status, body = self.client.call("POST", "/v1/questions", "elena", {"lang": "en", "title": "x" * 201})
        self.assertEqual(status, 400)
        status, body = self.client.call("POST", "/v1/questions", "elena", {"lang": "en", "title": "a\nb"})
        self.assertEqual(status, 400)
        status, body = self.client.call("POST", "/v1/questions", "elena", {"lang": "en", "title": "t", "tags": ["a b"]})
        self.assertEqual(body["error"]["field"], "tags[0]")
        status, body = self.client.call("POST", f"/v1/verses/{V(1)}/interpretations", "elena",
                                        {"lang": "en", "side": "pro", "bodyMd": "![a](https://a) " * 6})
        self.assertEqual((status, body["error"]["field"]), (400, "bodyMd"))
        status, body = self.client.call("GET", "/v1/questions?lang=fr")
        self.assertEqual(status, 400)

    def test_moderation(self):
        status, body = self.client.call("POST", f"/v1/verses/{V(1)}/interpretations", "elena",
                                        {"lang": "en", "side": "pro", "bodyMd": "text __reject__"})
        self.assertEqual(status, 422)
        self.assertEqual(body["error"]["code"], "moderation_rejected")
        self.assertIn("__reject__", body["error"]["reason"])
        status, body = self.client.call("POST", f"/v1/questions/{Q1}/arguments", "elena",
                                        {"lang": "en", "title": "__unavailable__"})
        self.assertEqual((status, body["error"]["code"]), (503, "moderation_unavailable"))
        _, full = self.client.call("GET", f"/v1/questions/{Q1}")
        self.assertEqual((len(full["arguments"]), len(full["interpretations"])), (3, 36))

    def test_routes(self):
        self.assertEqual(self.client.call("GET", "/v1/nope")[0], 404)
        status, headers, _ = self.client.raw("DELETE", "/v1/health")
        self.assertEqual((status, headers.get("Allow")), (405, "GET"))
        self.assertEqual(self.client.call("POST", "/v1/questions", body={"lang": "en", "title": "x"})[0], 401)

    def test_question_patch_and_delete(self):
        status, body = self.client.call("PATCH", f"/v1/questions/{Q1}", "david", {"tags": []})
        self.assertEqual((status, body["error"]["code"]), (403, "forbidden"))
        status, body = self.client.call("PATCH", f"/v1/questions/{Q1}", "anna", {"tags": ["Trinity", "godhead"]})
        self.assertEqual((status, body["tags"]), (200, ["trinity", "godhead"]))
        self.assertEqual(self.client.call("DELETE", f"/v1/questions/{Q1}", "anna")[1]["deleted"], "soft")
        _, full = self.client.call("GET", f"/v1/questions/{Q1}")
        self.assertTrue(full["question"]["deleted"])
        self.assertEqual(full["question"]["title"]["en"], "")
        self.assertEqual(len(full["verses"]), 17)
        status, _ = self.client.call("POST", f"/v1/questions/{Q1}/arguments", "elena", {"lang": "en", "title": "A"})
        self.assertEqual(status, 409)


if __name__ == "__main__":
    unittest.main()
