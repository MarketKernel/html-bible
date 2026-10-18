"""AI evaluation of verses: on add, on interpretation changes, delay, debounce, cache."""

from __future__ import annotations

import time
import unittest

from server.core.evaluation import evaluation_input, input_hash, live_interpretations, side_of_a
from server.llm.openai_stub import StubEvaluator
from server.tests.helpers import V, new_client, teardown


def interp(side="con", text="A long interpretation " * 10):
    return {"lang": "en", "side": side, "bodyMd": text}


class SyncEvaluationTest(unittest.TestCase):
    def setUp(self):
        self.client = new_client()

    def tearDown(self):
        teardown(self.client)

    def rating(self, verse):
        return self.client.call("GET", f"/v1/verses/{verse}/rating")[1]

    def test_seed_is_evaluated(self):
        ai = self.rating(V(1))["ai"]
        self.assertEqual(ai["status"], "fresh")
        self.assertEqual([v["model"] for v in ai["verdicts"]], ["openai-stub-mini", "openai-stub-large"])
        self.assertEqual(ai["verdicts"][0]["createdAt"], "2026-10-01T09:00:00.000Z")
        self.assertEqual(set(ai["verdicts"][0]),
                         {"verseId", "model", "value", "confidence", "rationaleMd", "inputHash", "createdAt"})
        rationale = ai["verdicts"][0]["rationaleMd"]
        self.assertNotIn("[A]", rationale["en"] + rationale["ru"])     # labels put back
        self.assertIn("Consistent", rationale["en"])
        self.assertIn("Соответствует", rationale["ru"])

    def test_interpretation_reevaluates(self):
        before = self.rating(V(1))["ai"]                               # pro outcome
        self.client.call("POST", f"/v1/verses/{V(1)}/interpretations", "elena", interp())
        self.client.call("POST", f"/v1/verses/{V(1)}/interpretations", "elena", interp())
        after = self.rating(V(1))["ai"]
        self.assertEqual(after["status"], "fresh")
        self.assertNotEqual(after["verdicts"][0]["inputHash"], before["verdicts"][0]["inputHash"])
        self.assertEqual(after["outcome"], -1)

    def test_hash_cache_and_mapping(self):
        app = self.client.app
        verse = app.store.get("verses", V(1))
        items = live_interpretations(app, V(1))
        digest = input_hash(verse, items)
        self.assertEqual(digest, input_hash(verse, list(reversed(items))))
        self.assertEqual(digest, verse["ai"]["inputHash"])
        calls = []
        original = app.evaluator.evaluate
        app.evaluator.evaluate = lambda model, data: calls.append(model) or original(model, data)
        app.scheduler.request(V(1))   # unchanged input: cached verdicts, no model calls
        self.assertEqual(calls, [])
        # The A/B labelling hides the sides: interpretations land under the right label.
        a_side = side_of_a(verse, items)
        data = evaluation_input(app, None, None, verse, items, a_side)
        self.assertEqual(len(data["interpretations"]["A"]), sum(1 for i in items if i["side"] == a_side))
        self.assertNotIn("side", data["interpretations"]["A"][0])
        self.assertIsNone(data["verse"]["text"])

    def test_verse_text_hook(self):
        seen = []
        self.client.app.verse_text = lambda ref: {"text": f"text of {ref['from']}", "context": "…"}
        original = self.client.app.evaluator.evaluate
        self.client.app.evaluator.evaluate = lambda model, data: seen.append(data["verse"]) or original(model, data)
        self.client.call("POST", f"/v1/arguments/01JAS000000000000000000A01/verses", "elena",
                         {"ref": {"from": "JHN.5.19", "to": "JHN.5.19"}})
        self.assertEqual(seen[0]["text"], "text of JHN.5.19")

    def test_stub_rules(self):
        evaluator = StubEvaluator()
        empty = {"interpretations": {"A": [], "B": []}}
        self.assertEqual(evaluator.evaluate("openai-stub-mini", empty)["answer"], "none")
        self.assertEqual(evaluator.evaluate("openai-stub-mini", empty)["confidence"], 0.3)
        one_sided = {"interpretations": {"A": [{"id": "x", "bodyMd": {"en": "text"}}], "B": []}}
        for model in evaluator.models:
            self.assertEqual(evaluator.evaluate(model, one_sided)["answer"], "A")
        self.assertEqual(evaluator.evaluate("openai-stub-large", one_sided)["confidence"], 0.8)
        self.assertEqual(evaluator.evaluate("openai-stub-mini", one_sided),
                         evaluator.evaluate("openai-stub-mini", one_sided))


class DelayedEvaluationTest(unittest.TestCase):
    def setUp(self):
        self.client = new_client(eval_delay=0.3)

    def tearDown(self):
        teardown(self.client)

    def rating(self, verse):
        return self.client.call("GET", f"/v1/verses/{verse}/rating")[1]

    def test_pending_then_fresh(self):
        before = self.rating(V(1))
        status, _ = self.client.call("POST", f"/v1/verses/{V(1)}/interpretations", "elena", interp())
        self.assertEqual(status, 201)
        pending = self.rating(V(1))
        self.assertEqual(pending["ai"]["status"], "pending")
        self.assertEqual(pending["ai"]["verdicts"], before["ai"]["verdicts"])     # old ones still shown
        self.assertEqual(pending["ai"]["outcome"], before["ai"]["outcome"])
        self.assertEqual(pending["argument"]["tally"]["aiStatus"], "pending")
        self.assertEqual(pending["question"]["tally"]["aiStatus"], "pending")
        deadline = time.time() + 5
        while time.time() < deadline:
            rating = self.rating(V(1))
            if rating["ai"]["status"] == "fresh":
                break
            time.sleep(0.05)
        self.assertEqual(rating["ai"]["status"], "fresh")
        self.assertNotEqual(rating["ai"]["verdicts"][0]["inputHash"], before["ai"]["verdicts"][0]["inputHash"])
        self.assertEqual(rating["question"]["tally"]["aiStatus"], "fresh")

    def test_new_verse_pending(self):
        status, verse = self.client.call("POST", "/v1/arguments/01JAS000000000000000000A01/verses", "elena",
                                         {"ref": {"from": "JHN.5.19", "to": "JHN.5.19"}})
        self.assertEqual((verse["ai"]["status"], verse["ai"]["outcome"], verse["ai"]["verdicts"]), ("pending", None, []))
        self.client.app.scheduler.flush()
        self.assertEqual(self.rating(verse["id"])["ai"]["status"], "fresh")

    def test_debounce(self):
        scheduler = self.client.app.scheduler
        runs = scheduler.runs
        for n in range(3):
            self.client.call("POST", f"/v1/verses/{V(2)}/interpretations", "elena", interp(text=f"Reading {n}"))
        self.assertEqual(scheduler.pending(), [V(2)])
        scheduler.flush()
        self.assertEqual(scheduler.runs, runs + 1)
        self.assertEqual(self.rating(V(2))["ai"]["status"], "fresh")

    def test_edit_and_delete_reevaluate(self):
        self.client.call("PATCH", "/v1/interpretations/01JAS000000000000000000T01", "anna",
                         {"lang": "en", "bodyMd": "Edited"})
        self.assertEqual(self.rating(V(1))["ai"]["status"], "pending")
        self.client.app.scheduler.flush()
        self.client.call("DELETE", "/v1/interpretations/01JAS000000000000000000T04", "anna")
        self.assertEqual(self.rating(V(2))["ai"]["status"], "pending")


if __name__ == "__main__":
    unittest.main()
