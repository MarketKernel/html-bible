"""Canonical book ids (USFM, KJV versification) and the optional verse counts.

Only the 66 canonical books may appear in discussions. Deuterocanonical ids are
listed separately so the server can say *why* a reference is refused.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Dict, List, Optional

CANONICAL_BOOKS = (
    "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA",
    "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO",
    "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS", "JOL", "AMO",
    "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
    "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH",
    "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
    "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
)
CANONICAL_SET = frozenset(CANONICAL_BOOKS)
BOOK_ORDER = {book: index for index, book in enumerate(CANONICAL_BOOKS)}

# The Synodal's extra books (Task.md §2.2) plus the other USFM deuterocanonical
# ids, so a client bug sending any of them gets `noncanonical_ref`, not a vague error.
NONCANONICAL_BOOKS = frozenset({
    "TOB", "JDT", "WIS", "SIR", "LJE", "BAR", "1MA", "2MA", "3MA", "4MA",
    "1ES", "2ES", "ESG", "S3Y", "SUS", "BEL", "MAN", "PS2", "ODA", "PSS",
    "EZA", "5EZ", "6EZ", "DAG", "LAO",
})

assert len(CANONICAL_BOOKS) == 66 and len(CANONICAL_SET) == 66


class VerseCounts:
    """KJV chapter/verse counts from data/meta/kjv-counts.json, loaded lazily.

    The file is produced by another tool and may not exist yet; while it is
    absent, callers only get `None` and validate "≥ 1". It is re-checked on
    each call until found, so a server started before the file appears picks
    it up without a restart.
    """

    def __init__(self, path: Optional[str]):
        self.path = path
        self._lock = threading.Lock()
        self._data: Optional[Dict[str, List[int]]] = None
        self._failed_mtime: Optional[float] = None

    def get(self) -> Optional[Dict[str, List[int]]]:
        if self._data is not None or not self.path:
            return self._data
        with self._lock:
            if self._data is not None:
                return self._data
            try:
                mtime = os.path.getmtime(self.path)
            except OSError:
                return None
            if self._failed_mtime == mtime:
                return None
            try:
                with open(self.path, "r", encoding="utf-8") as fh:
                    self._data = normalize_counts(json.load(fh))
            except (OSError, ValueError) as exc:
                self._failed_mtime = mtime
                print(f"[server] ignoring unreadable verse counts {self.path}: {exc}")
                return None
            return self._data

    def chapters(self, book: str) -> Optional[int]:
        data = self.get()
        if data is None or book not in data:
            return None
        return len(data[book])

    def verses(self, book: str, chapter: int) -> Optional[int]:
        data = self.get()
        if data is None or book not in data or not 1 <= chapter <= len(data[book]):
            return None
        return data[book][chapter - 1]


def normalize_counts(obj) -> Dict[str, List[int]]:
    """Accept the plausible shapes of the counts file and return {BOOK: [verses per chapter]}.

    The generator is written separately, so be liberal: a flat map, a map
    under "books", a list of {id, chapters}, or chapters given as objects.
    """
    if isinstance(obj, dict) and "books" in obj:
        obj = obj["books"]
    items = []
    if isinstance(obj, dict):
        items = list(obj.items())
    elif isinstance(obj, list):
        for entry in obj:
            if isinstance(entry, dict) and ("id" in entry or "book" in entry):
                items.append((entry.get("id") or entry.get("book"), entry))
    result: Dict[str, List[int]] = {}
    for book, value in items:
        if not isinstance(book, str) or book not in CANONICAL_SET:
            continue
        if isinstance(value, dict):
            value = value.get("chapters") or value.get("verses")
        if not isinstance(value, list):
            continue
        counts = []
        for chapter in value:
            if isinstance(chapter, dict):
                chapter = chapter.get("verses")
            if isinstance(chapter, list):
                chapter = len(chapter)
            if not isinstance(chapter, int) or isinstance(chapter, bool) or chapter < 1:
                break
            counts.append(chapter)
        else:
            if counts:
                result[book] = counts
    if not result:
        raise ValueError("no canonical books with verse counts found")
    return result
