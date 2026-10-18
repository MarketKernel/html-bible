"""The storage interface the core uses. Small on purpose, so DynamoDB can stand in:

- every item is a JSON object with a string "id" (the partition key);
- `query(table, field, value)` is an equality lookup on one attribute — in
  DynamoDB a GSI (arguments by questionId, verses by argumentId/questionId,
  interpretations by verseId/replyTo, votes by targetKey);
- `scan` is only used by verse-tags and the question list, which in DynamoDB
  become a tags table keyed by "BOOK.chapter" and a list index respectively.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from contextlib import contextmanager
from typing import Iterator, List, Optional

TABLES = (
    "users", "questions", "arguments", "verses", "interpretations", "votes", "verdicts",
    "auth_codes", "refresh_tokens", "meta",
)


class Store(ABC):
    @abstractmethod
    def get(self, table: str, item_id: str) -> Optional[dict]: ...

    @abstractmethod
    def put(self, table: str, item: dict) -> None: ...

    @abstractmethod
    def delete(self, table: str, item_id: str) -> bool: ...

    @abstractmethod
    def scan(self, table: str) -> List[dict]: ...

    def query(self, table: str, field: str, value) -> List[dict]:
        return [item for item in self.scan(table) if item.get(field) == value]

    @abstractmethod
    def clear(self) -> None:
        """Remove everything (local --reset and tests only)."""

    @contextmanager
    def batch(self) -> Iterator[None]:
        """Group writes; stores that can write in bulk override this."""
        yield
