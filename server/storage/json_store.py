"""Local storage: one JSON file per table in server/.data/, held in memory.

Each write rewrites its table's file atomically (temp file + rename), which is
plenty for a development stub. With `directory=None` nothing touches the disk.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import threading
from contextlib import contextmanager
from typing import Dict, Iterator, List, Optional, Set

from .base import TABLES, Store


class JsonStore(Store):
    def __init__(self, directory: Optional[str] = None):
        self.directory = directory
        self._lock = threading.RLock()
        self._tables: Dict[str, Dict[str, dict]] = {}
        self._batch_depth = 0
        self._dirty: Set[str] = set()

    def _table(self, table: str) -> Dict[str, dict]:
        if table not in TABLES:
            raise KeyError(f"unknown table {table}")
        if table not in self._tables:
            data: Dict[str, dict] = {}
            path = self._path(table)
            if path and os.path.exists(path):
                with open(path, "r", encoding="utf-8") as fh:
                    data = {item["id"]: item for item in json.load(fh)}
            self._tables[table] = data
        return self._tables[table]

    def _path(self, table: str) -> Optional[str]:
        return os.path.join(self.directory, f"{table}.json") if self.directory else None

    def _save(self, table: str) -> None:
        if self._batch_depth:
            self._dirty.add(table)
            return
        path = self._path(table)
        if not path:
            return
        os.makedirs(self.directory, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(list(self._tables[table].values()), fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    def get(self, table: str, item_id: str) -> Optional[dict]:
        with self._lock:
            item = self._table(table).get(item_id)
            return copy.deepcopy(item) if item is not None else None

    def put(self, table: str, item: dict) -> None:
        if not isinstance(item.get("id"), str):
            raise ValueError("items need a string id")
        with self._lock:
            self._table(table)[item["id"]] = copy.deepcopy(item)
            self._save(table)

    def delete(self, table: str, item_id: str) -> bool:
        with self._lock:
            removed = self._table(table).pop(item_id, None) is not None
            if removed:
                self._save(table)
            return removed

    def scan(self, table: str) -> List[dict]:
        with self._lock:
            return copy.deepcopy(list(self._table(table).values()))

    def clear(self) -> None:
        with self._lock:
            self._tables = {}
            self._dirty = set()
            if self.directory and os.path.isdir(self.directory):
                shutil.rmtree(self.directory)

    @contextmanager
    def batch(self) -> Iterator[None]:
        with self._lock:
            self._batch_depth += 1
            try:
                yield
            finally:
                self._batch_depth -= 1
                if not self._batch_depth:
                    dirty, self._dirty = self._dirty, set()
                    for table in dirty:
                        self._save(table)
