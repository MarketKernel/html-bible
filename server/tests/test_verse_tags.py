"""Verse tags: one per canonical verse key covered by each ArgumentVerse in the chapter."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from server.tests.helpers import A1, A3, Q1, V, new_client, teardown

JOHN = [51, 25, 36, 54, 47, 71, 53, 59, 41, 42, 57, 50, 38, 31, 27, 33, 26, 40, 42, 31, 25]


class VerseTagsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.client = new_client()

    def tearDown(self):
        teardown(self.client)
        shutil.rmtree(self.tmp)

    def tags(self, book, chapter, client=None):
        status, body = (client or self.client).call("GET", f"/v1/verse-tags?book={book}&chapter={chapter}")
        self.assertEqual(status, 200, body)
        self.assertEqual((body["book"], body["chapter"]), (book, chapter))
        return body["tags"]

    def test_shape(self):
        tags = self.tags("JHN", 14)
        self.assertEqual([t["key"] for t in tags], ["JHN.14.26", "JHN.14.28"])
        tag = tags[1]
        self.assertEqual(tag, {
            "key": "JHN.14.28", "questionId": Q1,
            "questionTitle": tag["questionTitle"], "argumentId": A1, "argumentTitle": tag["argumentTitle"],
            "verseId": V(7), "users": -1, "ai": tag["ai"],
        })
        self.assertEqual(tag["argumentTitle"]["en"], "The deity of Jesus")
        self.assertEqual(tag["questionTitle"]["orig"], "ru")
        self.assertIsNone(tags[0]["users"])        # JHN 14:26 is tied
        self.assertEqual(self.tags("JHN", 2), [])

    def test_range_expands(self):
        tags = self.tags("GEN", 1)                  # V13 = GEN 1:26–27
        self.assertEqual([(t["key"], t["verseId"]) for t in tags], [("GEN.1.26", V(13)), ("GEN.1.27", V(13))])
        self.assertEqual(tags[0]["argumentId"], A3)

    def test_range_across_chapters_with_counts(self):
        path = os.path.join(self.tmp, "kjv-counts.json")
        with open(path, "w") as fh:
            json.dump({"JHN": JOHN}, fh)
        client = new_client(counts_path=path)
        try:
            status, _ = client.call("POST", f"/v1/arguments/{A1}/verses", "elena",
                                    {"ref": {"from": "JHN.3.35", "to": "JHN.5.2"}})
            self.assertEqual(status, 201)
            self.assertEqual([t["key"] for t in self.tags("JHN", 3, client)], ["JHN.3.35", "JHN.3.36"])
            self.assertEqual(len(self.tags("JHN", 4, client)), 54)
            self.assertEqual([t["key"] for t in self.tags("JHN", 5, client)], ["JHN.5.1", "JHN.5.2"])
            status, body = client.call("GET", "/v1/verse-tags?book=JHN&chapter=22")
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_ref"))
        finally:
            teardown(client)

    def test_bad_requests(self):
        for query, code in (("book=TOB&chapter=1", "noncanonical_ref"), ("book=XYZ&chapter=1", "invalid_ref"),
                            ("book=JHN&chapter=0", "validation_error"), ("chapter=3", "validation_error"),
                            ("book=JHN", "validation_error"), ("book=JHN&chapter=x", "validation_error")):
            status, body = self.client.call("GET", f"/v1/verse-tags?{query}")
            self.assertEqual((status, body["error"]["code"]), (400, code), query)


if __name__ == "__main__":
    unittest.main()
