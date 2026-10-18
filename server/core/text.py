"""Validation of user text and the LocalizedText it is stored as (Task.md §2.5, §2.11)."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Optional

from .errors import validation

if TYPE_CHECKING:
    from .app import App

LANGS = ("ru", "en")

TITLE_MAX = 200
SIDE_MAX = 60
MD_MAX = 5000
IMAGES_MAX = 5
TAGS_MAX = 10
TAG_MAX = 32
NAME_MAX = 40

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(")


def require_lang(body: dict) -> str:
    lang = body.get("lang")
    if lang not in LANGS:
        raise validation('"lang" must be "ru" or "en"', "lang")
    return lang


def query_lang(params: dict) -> Optional[str]:
    """`?lang=` is accepted and checked, but responses always carry both languages."""
    lang = params.get("lang")
    if lang is not None and lang not in LANGS:
        raise validation('"lang" must be "ru" or "en"', "lang")
    return lang


def clean(value, field: str, max_len: int, min_len: int = 1, multiline: bool = False) -> str:
    if not isinstance(value, str):
        raise validation(f'"{field}" must be a string', field)
    value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not multiline and "\n" in value:
        raise validation(f'"{field}" must be one line', field)
    if _CONTROL_RE.search(value.replace("\t", " ")):
        raise validation(f'"{field}" contains control characters', field)
    if not min_len <= len(value) <= max_len:
        if min_len:
            raise validation(f'"{field}" must be {min_len}–{max_len} characters', field)
        raise validation(f'"{field}" must be at most {max_len} characters', field)
    return value


def clean_md(value, field: str, required: bool) -> str:
    value = clean(value, field, MD_MAX, 1 if required else 0, multiline=True)
    if len(_IMAGE_RE.findall(value)) > IMAGES_MAX:
        raise validation(f'"{field}" may contain at most {IMAGES_MAX} images', field)
    return value


def clean_tags(value) -> list:
    if not isinstance(value, list) or len(value) > TAGS_MAX:
        raise validation(f'"tags" must be a list of at most {TAGS_MAX} tags', "tags")
    tags = []
    for index, tag in enumerate(value):
        field = f"tags[{index}]"
        tag = clean(tag, field, TAG_MAX).lower()
        if not all(ch.isalnum() or ch == "-" for ch in tag):
            raise validation(f'"{field}" may only contain letters, digits and "-"', field)
        if tag not in tags:
            tags.append(tag)
    return tags


def localize(app: "App", text: str, lang: str) -> dict:
    """Store what the author wrote under its language and fill the other one by translation."""
    result = {"orig": lang}
    for target in LANGS:
        result[target] = text if target == lang else app.translator.translate(text, lang, target)
    return result


def blank(text: dict) -> dict:
    """What remains of a text deleted by its author."""
    return {"orig": text.get("orig", "en"), "ru": "", "en": ""}
