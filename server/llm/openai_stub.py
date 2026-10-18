"""Deterministic stand-ins for the OpenAI models. No network, same interfaces."""

from __future__ import annotations

from typing import Dict, List, Tuple

from .base import Evaluator, ModerationResult, ModerationUnavailable, Moderator, Translator

REJECT_WORD = "__reject__"
UNAVAILABLE_WORD = "__unavailable__"


class StubTranslator(Translator):
    def translate(self, text: str, source: str, target: str) -> str:
        if not text:
            return text
        return f"[auto-translated {source}→{target}] {text}"


class StubModerator(Moderator):
    """Allows everything, except two magic words that let the client test its error paths."""

    def moderate(self, texts: List[str], lang: str) -> ModerationResult:
        joined = "\n".join(texts)
        if UNAVAILABLE_WORD in joined:
            raise ModerationUnavailable("stub moderator told to be unavailable")
        if REJECT_WORD in joined:
            reason = (
                "Текст отклонён модерацией (тестовое слово __reject__)."
                if lang == "ru"
                else "The text was rejected by moderation (test word __reject__)."
            )
            return ModerationResult(False, reason)
        return ModerationResult(True)


# Per model: weight of an interpretation, weight per 100 characters, the
# relative margin below which the verse counts as "not relevant", confidence.
STUB_MODELS: Dict[str, Tuple[float, float, float, float]] = {
    "openai-stub-mini": (1.0, 0.5, 0.05, 0.6),
    "openai-stub-large": (0.5, 1.0, 0.1, 0.8),
}
NO_TEXT_CONFIDENCE = 0.3


class StubEvaluator(Evaluator):
    """S_side = wn·count + wl·chars/100 over each side's interpretations.

    margin = (S_A − S_B) / (S_A + S_B); |margin| < threshold → "none",
    otherwise the larger side. No interpretations → "none", confidence 0.3.
    Pure counting, so adding an interpretation visibly moves the AI, and the
    two models sometimes disagree (different weights → AI outcome null).
    """

    models = tuple(STUB_MODELS)

    def evaluate(self, model: str, data: dict) -> dict:
        wn, wl, threshold, confidence = STUB_MODELS[model]
        stats = {}
        for label in ("A", "B"):
            items = data["interpretations"][label]
            chars = sum(len(i["bodyMd"].get("en") or "") for i in items)
            stats[label] = (len(items), chars, wn * len(items) + wl * chars / 100)
        (na, ca, sa), (nb, cb, sb) = stats["A"], stats["B"]
        if na + nb == 0:
            answer, confidence = "none", NO_TEXT_CONFIDENCE
            en_end = "nobody has explained the verse yet, so it counts as not relevant for now."
            ru_end = "толкований пока нет, поэтому стих пока считается не относящимся к теме."
        else:
            margin = (sa - sb) / (sa + sb)
            if abs(margin) < threshold:
                answer, confidence = "none", round(confidence - 0.2, 2)
                en_end = "the readings are evenly matched; the verse does not decide the question."
                ru_end = "толкования уравновешены; стих не решает вопрос."
            else:
                answer = "A" if margin > 0 else "B"
                en_end = f"the verse supports [{answer}]."
                ru_end = f"стих подтверждает позицию [{answer}]."
        en = (
            f"**{model}** (stub) read {na} interpretation(s) for [A] ({ca} characters) and "
            f"{nb} for [B] ({cb} characters): {en_end}"
        )
        ru = (
            f"**{model}** (заглушка) прочла толкований за [A]: {na} ({ca} знаков), "
            f"за [B]: {nb} ({cb} знаков): {ru_end}"
        )
        return {"answer": answer, "confidence": confidence, "rationaleMd": {"orig": "en", "ru": ru, "en": en}}
