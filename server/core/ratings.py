"""Outcomes and tallies (Task.md §3 "Стих — одно очко").

A verse is one point on the scale. People and models each give it an
outcome: 1 (supports the first position, "pro"), -1 (the second, "con"),
0 (not relevant) or None (undecided). A subtopic's and a topic's score is
the tally of their verses' outcomes. AI and people are never mixed.
Pure functions over plain data, so the rules are tested without a server.
"""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence

VALUES = (1, -1, 0)
TALLY_KEYS = {1: "pro", -1: "con", 0: "none"}


def outcome(values: Iterable[int]) -> Optional[int]:
    """The value with the most votes; None if there are no votes or the top two tie.

    Used for both people (their votes) and AI (one value per model):
    [1, 1, -1] → 1; [1, -1] → None; [0, 0, 1] → 0; [] → None.
    """
    counts = {v: 0 for v in VALUES}
    for value in values:
        if value in counts:
            counts[value] += 1
    ranked = sorted(counts.values(), reverse=True)
    if ranked[0] == 0 or ranked[0] == ranked[1]:
        return None
    return next(v for v in VALUES if counts[v] == ranked[0])


def verse_votes(values: Sequence[int], mine: Optional[int], viewer: bool) -> dict:
    """{pro, con, none} counts; `mine` only for a signed-in viewer (None = no vote)."""
    summary = {
        "pro": sum(1 for v in values if v == 1),
        "con": sum(1 for v in values if v == -1),
        "none": sum(1 for v in values if v == 0),
    }
    if viewer:
        summary["mine"] = mine
    return summary


def updown_votes(values: Sequence[int], mine: Optional[int], viewer: bool) -> dict:
    """{up, down} of an interpretation (+ / −); `mine` only for a signed-in viewer.
    These never feed outcomes, tallies or the AI."""
    summary = {"up": sum(1 for v in values if v == 1), "down": sum(1 for v in values if v == -1)}
    if viewer:
        summary["mine"] = mine
    return summary


def verse_ai(verdicts: Sequence[dict], status: str) -> dict:
    """{outcome, status, verdicts}: majority of the models' values, a tie is None.

    While re-evaluating ("pending") the previous verdicts still decide the
    outcome, so the client shows the last known result next to "AI is recalculating…".
    """
    return {"outcome": outcome(v["value"] for v in verdicts), "status": status, "verdicts": list(verdicts)}


def empty_tally() -> dict:
    return {"pro": 0, "con": 0, "none": 0, "open": 0}


def tally(outcomes: Iterable[Optional[int]]) -> dict:
    """Count verse outcomes: pro (1), con (-1), none (0), open (None)."""
    result = empty_tally()
    for value in outcomes:
        result[TALLY_KEYS.get(value, "open")] += 1
    return result


def ai_status(statuses: Sequence[str]) -> str:
    """'none' without verses, 'pending' if any verse is being evaluated, else 'fresh'."""
    if not statuses:
        return "none"
    return "pending" if "pending" in statuses else "fresh"


def tallies(verses: Sequence[dict]) -> dict:
    """Tallies of a subtopic or topic from its rendered verses ({users: {outcome}, ai: {outcome, status}}).

    A topic's tally is the sum over its subtopics, which equals the tally of
    all its verses, so both use this function.
    """
    return {
        "users": tally(v["users"]["outcome"] for v in verses),
        "ai": tally(v["ai"]["outcome"] for v in verses),
        "aiStatus": ai_status([v["ai"]["status"] for v in verses]),
    }


def add_tallies(parts: List[dict]) -> dict:
    """Sum Tallies objects (used by tests to check topic = Σ subtopics)."""
    out = {"users": empty_tally(), "ai": empty_tally()}
    statuses: List[str] = []
    for part in parts:
        for who in ("users", "ai"):
            for key in out[who]:
                out[who][key] += part[who][key]
        if part["aiStatus"] != "none":
            statuses.append(part["aiStatus"])
    out["aiStatus"] = ai_status(statuses)
    return out


def lean(t: dict) -> Optional[int]:
    """For the scale (client side, documented here): (pro − con) / (pro + con) × 100."""
    decided = t["pro"] + t["con"]
    if not decided:
        return None
    value = 100 * (t["pro"] - t["con"]) / decided
    return int(value + 0.5) if value >= 0 else -int(-value + 0.5)
