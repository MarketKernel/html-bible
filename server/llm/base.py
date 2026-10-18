"""What the save pipeline needs from language models (Task.md §6.1–6.3).

The stub (openai_stub.py) and the future OpenAI client (openai.py) implement
the same three interfaces; the core never knows which one it talks to.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Optional, Sequence


class Translator(ABC):
    @abstractmethod
    def translate(self, text: str, source: str, target: str) -> str:
        """Markdown in, Markdown out; verse references and URLs untouched."""


@dataclass
class ModerationResult:
    allowed: bool
    reason: Optional[str] = None  # in the author's language, shown in the form


class ModerationUnavailable(Exception):
    """The moderator could not answer; the pipeline saves nothing (503)."""


class Moderator(ABC):
    @abstractmethod
    def moderate(self, texts: List[str], lang: str) -> ModerationResult: ...


class Evaluator(ABC):
    """Judges one verse of a subtopic: does it support position A, position B, or neither?

    `data` is built by core.evaluation.evaluation_input. The positions are
    shuffled and labelled "A"/"B" against bias, and the model never sees votes:

        { "question": { id, title, positions: { A: LocalizedText, B: LocalizedText } },
          "argument": { id, title, summaryMd },
          "verse": { id, ref: RefRange, text: str | None, context: str | None },
          "interpretations": { "A": [ { id, bodyMd, replyTo? } ], "B": [...] } }

    `verse.text` / `verse.context` (KJV, ±3 verses) come from App.verse_text when
    one is installed; the stub runs without them. Models read the "en" texts.

    Returns { "answer": "A" | "B" | "none", "confidence": 0…1, "rationaleMd": LocalizedText }.
    The rationale may say "[A]" and "[B]"; the core replaces them with the
    position labels and maps the answer back to 1 / -1 / 0.
    """

    models: Sequence[str] = ()

    @abstractmethod
    def evaluate(self, model: str, data: dict) -> dict: ...
