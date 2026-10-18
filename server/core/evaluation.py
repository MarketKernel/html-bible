"""Automatic AI evaluation of a verse (Task.md §6, §6.1).

Flow: adding a verse, or adding / editing / deleting an interpretation of it,
marks the verse `ai.status = "pending"` and asks the scheduler to evaluate
it. With `eval_delay == 0` that happens right away, in the request. With a
delay, a timer runs it later and the client polls GET /v1/verses/{id}/rating.

Debounce: while an evaluation of a verse is already scheduled, further
requests for it are not queued again — the scheduled run reads the verse and
its interpretations as they are *when it fires*, so several quick
interpretations cost one evaluation. (In AWS: an SQS message with a delay
plus a "scheduled" flag on the verse; see docs/deploy.md.)

Cache: a verdict is stored under inputHash + model, so an unchanged input is
never sent to a model twice.

Against bias the positions are shown to models shuffled, as "A" and "B".
Which side is A is derived from the content: stable for one input (so the
cache stays valid) but not always "pro".
"""

from __future__ import annotations

import hashlib
import json
import threading
import traceback
from typing import TYPE_CHECKING, Dict, List, Optional

if TYPE_CHECKING:
    from .app import App

def live_interpretations(app: "App", verse_id: str) -> List[dict]:
    items = [i for i in app.store.query("interpretations", "verseId", verse_id) if not i.get("deleted")]
    return sorted(items, key=lambda i: (i["createdAt"], i["id"]))


def input_hash(verse: dict, interpretations: List[dict]) -> str:
    """sha256 (hex) of the canonical JSON of the verse and its live interpretations.

    Canonical = keys sorted, no whitespace, UTF-8, interpretations ordered by id:
    {"interpretations":[{"bodyMd","id","replyTo"?,"side"}],"verse":{"id","ref"}}
    """
    items = []
    for item in sorted(interpretations, key=lambda i: i["id"]):
        entry = {"id": item["id"], "side": item["side"], "bodyMd": item["bodyMd"]}
        if item.get("replyTo"):
            entry["replyTo"] = item["replyTo"]
        items.append(entry)
    data = {"verse": {"id": verse["id"], "ref": verse["ref"]}, "interpretations": items}
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def side_of_a(verse: dict, interpretations: List[dict]) -> str:
    """Which side is shown to the models as "A": derived from the content only
    (the reference and the texts, not ids or times), so the same input always
    gets the same labelling and is still not always "pro"."""
    content = [verse["ref"]["from"], verse["ref"]["to"]] + sorted(
        f"{i['side']}:{i['bodyMd'].get(i['bodyMd'].get('orig', 'en'), '')}" for i in interpretations
    )
    digest = hashlib.sha256(json.dumps(content, ensure_ascii=False).encode("utf-8")).hexdigest()
    return "pro" if int(digest[-1], 16) % 2 == 0 else "con"


def evaluation_input(app: "App", question: Optional[dict], argument: Optional[dict], verse: dict,
                     interpretations: List[dict], a_side: str) -> dict:
    b_side = "con" if a_side == "pro" else "pro"
    label = {a_side: "A", b_side: "B"}
    text = app.verse_text(verse["ref"]) if app.verse_text else None
    sides = (question or {}).get("sides") or {}
    return {
        "question": {
            "id": question["id"] if question else None,
            "title": question["title"] if question else None,
            "positions": {"A": sides.get(a_side), "B": sides.get(b_side)},
        },
        "argument": {
            "id": argument["id"] if argument else None,
            "title": argument["title"] if argument else None,
            "summaryMd": argument["summaryMd"] if argument else None,
        },
        "verse": {
            "id": verse["id"],
            "ref": verse["ref"],
            "text": (text or {}).get("text"),
            "context": (text or {}).get("context"),
        },
        "interpretations": {
            lab: [
                dict({"id": i["id"], "bodyMd": i["bodyMd"]}, **({"replyTo": i["replyTo"]} if i.get("replyTo") else {}))
                for i in interpretations if label[i["side"]] == lab
            ]
            for lab in ("A", "B")
        },
    }


def _relabel(rationale: dict, question: Optional[dict], a_side: str) -> dict:
    """Put the position labels where the model wrote [A] / [B]."""
    b_side = "con" if a_side == "pro" else "pro"
    sides = (question or {}).get("sides") or {}
    out = {"orig": rationale.get("orig", "en")}
    for lang in ("ru", "en"):
        text = rationale.get(lang) or ""
        for token, side in (("[A]", a_side), ("[B]", b_side)):
            name = (sides.get(side) or {}).get(lang) or side
            text = text.replace(token, f"«{name}»" if lang == "ru" else f"“{name}”")
        out[lang] = text
    return out


class EvaluationScheduler:
    def __init__(self, app: "App"):
        self.app = app
        self._timers: Dict[str, threading.Timer] = {}
        self._lock = threading.Lock()
        self.runs = 0  # evaluations actually performed (tests check the debounce)

    def request(self, verse_id: str) -> None:
        """Mark the verse pending and evaluate it now or after the delay."""
        app = self.app
        with app.lock:
            verse = app.store.get("verses", verse_id)
            if verse is None:
                return
            verse["ai"]["status"] = "pending"
            app.store.put("verses", verse)
        delay = app.config.eval_delay
        if delay <= 0:
            self.run(verse_id)
            return
        with self._lock:
            if verse_id in self._timers:
                return  # debounce: the scheduled run will see this change too
            timer = threading.Timer(delay, self._fire, args=(verse_id,))
            timer.daemon = True
            self._timers[verse_id] = timer
            timer.start()

    def _fire(self, verse_id: str) -> None:
        with self._lock:
            self._timers.pop(verse_id, None)
        try:
            self.run(verse_id)
        except Exception:
            traceback.print_exc()

    def pending(self) -> List[str]:
        with self._lock:
            return list(self._timers)

    def flush(self) -> None:
        """Run every scheduled evaluation now (tests, shutdown)."""
        with self._lock:
            timers, self._timers = self._timers, {}
        for verse_id, timer in timers.items():
            timer.cancel()
            self.run(verse_id)

    def shutdown(self) -> None:
        with self._lock:
            timers, self._timers = self._timers, {}
        for timer in timers.values():
            timer.cancel()

    def run(self, verse_id: str, at: Optional[str] = None) -> None:
        """Evaluate the verse with every configured model and store the verdicts."""
        app = self.app
        with app.lock:
            verse = app.store.get("verses", verse_id)
            if verse is None:
                return
            self.runs += 1
            interpretations = live_interpretations(app, verse_id)
            previous = verse["ai"].get("verdicts", [])
            digest = input_hash(verse, interpretations)
            a_side = side_of_a(verse, interpretations)
            question = app.store.get("questions", verse["questionId"])
            argument = app.store.get("arguments", verse["argumentId"])
            data = evaluation_input(app, question, argument, verse, interpretations, a_side)
            values = {"A": 1 if a_side == "pro" else -1, "B": -1 if a_side == "pro" else 1, "none": 0}
            verdicts = []
            try:
                for model in app.evaluator.models:
                    cache_id = f"{digest}:{model}"
                    cached = app.store.get("verdicts", cache_id)
                    if cached is None:
                        draft = app.evaluator.evaluate(model, data)
                        verdict = {
                            "verseId": verse_id,
                            "model": model,
                            "value": values[draft["answer"]],
                            "confidence": draft["confidence"],
                            "rationaleMd": _relabel(draft["rationaleMd"], question, a_side),
                            "inputHash": digest,
                            "createdAt": at or app.now_iso(),
                        }
                        app.store.put("verdicts", {"id": cache_id, "verdict": verdict})
                    else:
                        verdict = cached["verdict"]
                    verdicts.append(verdict)
            except Exception:
                # A failed model keeps the last verdicts; the next change retries.
                traceback.print_exc()
                verse["ai"] = {"status": "fresh" if previous else "none", "verdicts": previous}
                app.store.put("verses", verse)
                return
            verse["ai"] = {"status": "fresh", "verdicts": verdicts, "inputHash": digest}
            app.store.put("verses", verse)
