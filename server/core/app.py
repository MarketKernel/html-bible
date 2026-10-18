"""The application object: settings, storage, models, clock, id source.

Handlers get it with `get_app()`. It is built lazily from the environment on
first use (Lambda cold start); the local server and tests install their own
with `set_app()`. Importing this module does nothing else.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Callable, Optional

from ..llm.base import Evaluator, Moderator, Translator
from ..llm.openai_stub import StubEvaluator, StubModerator, StubTranslator
from ..storage.base import Store
from ..storage.json_store import JsonStore
from .books import VerseCounts
from .config import Config
from .evaluation import EvaluationScheduler
from .ids import iso, ulid


class App:
    def __init__(
        self,
        config: Optional[Config] = None,
        store: Optional[Store] = None,
        clock: Optional[Callable[[], float]] = None,
        translator: Optional[Translator] = None,
        moderator: Optional[Moderator] = None,
        evaluator: Optional[Evaluator] = None,
        random_bytes: Callable[[int], bytes] = os.urandom,
        verse_text: Optional[Callable[[dict], Optional[dict]]] = None,
    ):
        self.config = config or Config()
        self.store = store if store is not None else JsonStore(self.config.data_dir)
        self.clock = clock or time.time
        self.translator = translator or StubTranslator()
        self.moderator = moderator or StubModerator()
        self.evaluator = evaluator or StubEvaluator()
        self.random_bytes = random_bytes
        # Hook for the evaluator: RefRange → {"text", "context"} (KJV, ±3 verses).
        # None until the server gets access to the KJV text; the stub needs none.
        self.verse_text = verse_text
        self.counts = VerseCounts(self.config.kjv_counts_path)
        # One lock for every read-modify-write: the stub favours simple and
        # correct over concurrent. DynamoDB would use conditional writes.
        self.lock = threading.RLock()
        self.scheduler = EvaluationScheduler(self)

    def now(self) -> float:
        return self.clock()

    def now_iso(self) -> str:
        return iso(self.clock())

    def new_id(self) -> str:
        return ulid(self.clock(), self.random_bytes)

    def shutdown(self) -> None:
        self.scheduler.shutdown()


_app: Optional[App] = None
_app_lock = threading.Lock()


def get_app() -> App:
    global _app
    if _app is None:
        with _app_lock:
            if _app is None:
                _app = App(Config.from_env())
    return _app


def set_app(app: Optional[App]) -> None:
    global _app
    with _app_lock:
        _app = app
