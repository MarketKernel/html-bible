"""Canonical verse keys ("JHN.3.16") and ranges ({ from, to }).

Discussions only ever hold canonical references (KJV versification); anything
else is refused here, at the edge, with a code the client can explain.
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

from .books import BOOK_ORDER, CANONICAL_SET, NONCANONICAL_BOOKS, VerseCounts
from .errors import ApiError

# No leading zeros: "JHN.03.16" is not a canonical key.
KEY_RE = re.compile(r"^([1-9A-Z][A-Z0-9]{2})\.([1-9][0-9]{0,2})\.([1-9][0-9]{0,2})$")
BOOK_RE = re.compile(r"^[1-9A-Z][A-Z0-9]{2}$")

# Longest chapter (Psalm 119). Used only to expand cross-chapter ranges while
# the verse counts file is missing; tags on verses that do not exist are harmless.
MAX_VERSES_FALLBACK = 176

Key = Tuple[str, int, int]


def invalid_ref(message: str, field: Optional[str]) -> ApiError:
    return ApiError(400, "invalid_ref", message, field=field)


def noncanonical_ref(book: str, field: Optional[str]) -> ApiError:
    return ApiError(
        400,
        "noncanonical_ref",
        f"{book} is not a canonical book; discussions only cite the 66 canonical books",
        field=field,
    )


def check_book(book: str, field: Optional[str] = None) -> str:
    if book in CANONICAL_SET:
        return book
    if book in NONCANONICAL_BOOKS:
        raise noncanonical_ref(book, field)
    raise invalid_ref(f"Unknown book id {book!r}", field)


def parse_key(value, counts: Optional[VerseCounts] = None, field: Optional[str] = None) -> Key:
    if not isinstance(value, str):
        raise invalid_ref("A verse key must be a string like JHN.3.16", field)
    match = KEY_RE.match(value)
    if not match:
        book = value.split(".", 1)[0]
        if book in NONCANONICAL_BOOKS:
            raise noncanonical_ref(book, field)
        raise invalid_ref(f"{value!r} is not a canonical verse key like JHN.3.16", field)
    book, chapter, verse = match.group(1), int(match.group(2)), int(match.group(3))
    check_book(book, field)
    if counts is not None:
        chapters = counts.chapters(book)
        if chapters is not None and chapter > chapters:
            raise invalid_ref(f"{book} has {chapters} chapters", field)
        verses = counts.verses(book, chapter)
        if verses is not None and verse > verses:
            raise invalid_ref(f"{book} {chapter} has {verses} verses", field)
    return book, chapter, verse


def format_key(key: Key) -> str:
    return f"{key[0]}.{key[1]}.{key[2]}"


def parse_range(value, counts: Optional[VerseCounts] = None, field: str = "ref") -> dict:
    """Validate one RefRange and return it as a fresh {from, to} dict."""
    if not isinstance(value, dict) or "from" not in value or "to" not in value:
        raise invalid_ref("A reference must be an object { from, to }", field)
    start = parse_key(value["from"], counts, f"{field}.from")
    end = parse_key(value["to"], counts, f"{field}.to")
    if start[0] != end[0]:
        raise invalid_ref("A range must stay within one book", field)
    if (start[1], start[2]) > (end[1], end[2]):
        raise invalid_ref("A range must not end before it starts", field)
    return {"from": format_key(start), "to": format_key(end)}


def verses_in_chapter(ref: dict, book: str, chapter: int, counts: Optional[VerseCounts]) -> List[int]:
    """The verse numbers of `book chapter` that the range covers (ranges may span chapters)."""
    fb, fc, fv = parse_key(ref["from"])
    _, tc, tv = parse_key(ref["to"])
    if fb != book or not fc <= chapter <= tc:
        return []
    first = fv if chapter == fc else 1
    if chapter == tc:
        last = tv
    else:
        known = counts.verses(book, chapter) if counts is not None else None
        last = known if known is not None else MAX_VERSES_FALLBACK
    return list(range(first, last + 1))


def sort_key(key: str) -> Tuple[int, int, int]:
    book, chapter, verse = parse_key(key)
    return BOOK_ORDER[book], chapter, verse
