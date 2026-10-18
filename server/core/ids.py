"""ULIDs (Task.md §3) and ISO timestamps, without third-party packages."""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Callable

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def ulid(now: float, random_bytes: Callable[[int], bytes] = os.urandom) -> str:
    """48-bit millisecond time + 80 random bits, Crockford base32 (sortable by time)."""
    value = (int(now * 1000) & ((1 << 48) - 1)) << 80 | int.from_bytes(random_bytes(10), "big")
    chars = []
    for _ in range(26):
        chars.append(CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(chars))


def iso(now: float) -> str:
    """UTC with milliseconds: 2026-10-18T12:00:00.000Z."""
    moment = datetime.fromtimestamp(now, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def parse_iso(value: str) -> float:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp()
