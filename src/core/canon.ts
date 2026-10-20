/**
 * Between a translation's own numbering and canonical keys (KJV numbering).
 *
 * Comments, discussion tags and comparison work with canonical keys; the
 * reader shows native verses. This module is the one place that crosses over,
 * and the one rule lives here: a noncanonical verse (a deuterocanonical book,
 * an insertion like Dan 3:24–90 in the Synodal) has no key, so everything
 * built on keys simply does not see it.
 */

import { type AnyBookId, type BookId, bookOrder, isBookId, isCanonicalBook } from './books';
import type { ParsedRef, RefPart } from './refs';
import type { RefRange, Translation, VerseKey, VerseLoc } from './types';
import { KJV_COUNTS } from './versification/kjv-counts';
import { versification } from './versification/map';

export interface CanonVerse {
  book: BookId;
  chapter: number;
  verse: number;
}

export function keyOf(loc: CanonVerse): VerseKey {
  return `${loc.book}.${loc.chapter}.${loc.verse}` as VerseKey;
}

export function parseKey(key: string): CanonVerse | undefined {
  const match = /^([1-3A-Z]{3})\.(\d{1,3})\.(\d{1,3})$/.exec(key);
  if (!match || !isCanonicalBook(match[1]!)) return undefined;
  return { book: match[1] as BookId, chapter: Number(match[2]), verse: Number(match[3]) };
}

/** "JHN.3.16-JHN.3.18" → range; "JHN.3.16" → one verse. */
export function parseRange(text: string): RefRange | undefined {
  const [from, to] = text.split('-');
  if (!from || !parseKey(from)) return undefined;
  if (to === undefined) return { from: from as VerseKey, to: from as VerseKey };
  if (!parseKey(to)) return undefined;
  return { from: from as VerseKey, to: to as VerseKey };
}

export function rangeText(range: RefRange): string {
  return range.from === range.to ? range.from : `${range.from}-${range.to}`;
}

/** Order of two keys; across books by the canonical order. */
export function compareKeys(a: CanonVerse, b: CanonVerse): number {
  return bookOrder(a.book) - bookOrder(b.book) || a.chapter - b.chapter || a.verse - b.verse;
}

export function rangeContains(range: RefRange, key: CanonVerse): boolean {
  const from = parseKey(range.from);
  const to = parseKey(range.to);
  return !!from && !!to && compareKeys(from, key) <= 0 && compareKeys(key, to) <= 0;
}

export function rangesOverlap(a: RefRange, b: RefRange): boolean {
  const [af, at, bf, bt] = [parseKey(a.from), parseKey(a.to), parseKey(b.from), parseKey(b.to)];
  return !!af && !!at && !!bf && !!bt && compareKeys(af, bt) <= 0 && compareKeys(bf, at) <= 0;
}

export function verseCount(translation: Translation, book: string, chapter: number): number {
  return translation.books.find((b) => b.id === book)?.chapters[chapter - 1]?.length ?? 0;
}

export function verseText(translation: Translation, loc: VerseLoc): string | undefined {
  const text = translation.books.find((b) => b.id === loc.book)?.chapters[loc.chapter - 1]?.[loc.verse - 1];
  return text || undefined;
}

export function isNoncanonical(translation: Translation, loc: VerseLoc): boolean {
  const book = translation.books.find((b) => b.id === loc.book);
  if (!book || book.canonical === false || !isCanonicalBook(loc.book)) return true;
  return versification(translation.versification).isNoncanonical(loc);
}

/** Languages written right to left (the Hebrew Old Testament). */
const RTL = new Set(['hbo', 'he', 'arc']);

/** lang and dir for an element holding a translation's text: Hebrew runs right to left, and lang picks fitting fonts. */
export function textAttrs(translation: Translation): { lang: string; dir?: 'rtl' } {
  return RTL.has(translation.lang) ? { lang: translation.lang, dir: 'rtl' } : { lang: translation.lang };
}

/** A native verse's canonical key; null for noncanonical. */
export function toKey(translation: Translation, loc: VerseLoc): CanonVerse | null {
  if (isNoncanonical(translation, loc)) return null;
  return versification(translation.versification).toCanonical(loc);
}

/** The native verses of a canonical one (usually one, none when missing). */
export function fromKey(translation: Translation, key: CanonVerse): VerseLoc[] {
  return versification(translation.versification)
    .fromCanonical(key)
    .filter((loc) => verseText(translation, loc) !== undefined);
}

/** A part's first and last verse in one book's numbering; open ends filled from the verse counts. */
function partEnds(part: RefPart, lastVerse: (chapter: number) => number): [{ chapter: number; verse: number }, { chapter: number; verse: number }] {
  const endChapter = part.endChapter ?? part.chapter;
  return [
    { chapter: part.chapter, verse: part.verse ?? 1 },
    { chapter: endChapter, verse: part.endVerse ?? part.verse ?? lastVerse(endChapter) },
  ];
}

/**
 * A reference in a translation's numbering → canonical ranges. Parts that are
 * noncanonical drop out; a range whose ends are noncanonical shrinks to the
 * canonical verses inside it.
 */
export function refToRanges(translation: Translation, ref: ParsedRef): RefRange[] {
  const ranges: RefRange[] = [];
  for (const part of ref.parts) {
    const [start, end] = partEnds(part, (chapter) => verseCount(translation, ref.book, chapter));
    const keys: CanonVerse[] = [];
    for (let chapter = start.chapter; chapter <= end.chapter; chapter += 1) {
      const count = verseCount(translation, ref.book, chapter);
      const first = chapter === start.chapter ? start.verse : 1;
      const last = chapter === end.chapter ? Math.min(end.verse, count) : count;
      for (let verse = first; verse <= last; verse += 1) {
        const key = toKey(translation, { book: ref.book, chapter, verse });
        if (key) keys.push(key);
      }
    }
    if (!keys.length) continue;
    keys.sort(compareKeys);
    ranges.push({ from: keyOf(keys[0]!), to: keyOf(keys.at(-1)!) });
  }
  return ranges;
}

/**
 * A reference written in canonical numbering (a link without a translation,
 * a comment's range) → the same verses in a translation's numbering.
 */
export function canonicalRefToNative(translation: Translation, ref: ParsedRef): ParsedRef | undefined {
  if (!isCanonicalBook(ref.book)) return undefined;
  const parts: RefPart[] = [];
  let book: AnyBookId | undefined;
  for (const part of ref.parts) {
    const from = part.verse ?? 1;
    const native = fromKey(translation, { book: ref.book as BookId, chapter: part.chapter, verse: from });
    if (part.verse === undefined) {
      // A whole chapter: the chapter its first verse is in.
      const loc = native[0];
      if (loc) {
        book = loc.book;
        parts.push({ chapter: loc.chapter });
      }
      continue;
    }
    const endKey = { book: ref.book as BookId, chapter: part.endChapter ?? part.chapter, verse: part.endVerse ?? part.verse };
    const nativeEnd = fromKey(translation, endKey).at(-1);
    const start = native[0];
    if (!start) continue;
    book = start.book;
    const end = nativeEnd ?? start;
    if (end.chapter === start.chapter && end.verse === start.verse) parts.push({ chapter: start.chapter, verse: start.verse });
    else if (end.chapter === start.chapter) parts.push({ chapter: start.chapter, verse: start.verse, endVerse: end.verse });
    else parts.push({ chapter: start.chapter, verse: start.verse, endChapter: end.chapter, endVerse: end.verse });
  }
  return book && parts.length ? { book, parts } : undefined;
}

/** Verses in a canonical chapter (KJV numbering); 0 when there is no such chapter. */
export function canonicalVerseCount(book: BookId, chapter: number): number {
  return KJV_COUNTS[book]?.[chapter - 1] ?? 0;
}

/** A canonical range → native verses of a translation, in order. */
export function rangeToNative(translation: Translation, range: RefRange): VerseLoc[] {
  const from = parseKey(range.from);
  const to = parseKey(range.to);
  if (!from || !to || from.book !== to.book) return [];
  const out: VerseLoc[] = [];
  const seen = new Set<string>();
  for (let chapter = from.chapter; chapter <= to.chapter; chapter += 1) {
    const last = chapter === to.chapter ? to.verse : canonicalVerseCount(from.book, chapter);
    for (let verse = chapter === from.chapter ? from.verse : 1; verse <= last; verse += 1) {
      for (const loc of fromKey(translation, { book: from.book, chapter, verse })) {
        const id = `${loc.book}.${loc.chapter}.${loc.verse}`;
        if (!seen.has(id)) {
          seen.add(id);
          out.push(loc);
        }
      }
    }
  }
  return out;
}

/**
 * A reference written in some numbering scheme (a Synodal commentary's «Пс 90:11»)
 * → the same verses in canonical numbering; undefined when it is noncanonical.
 */
export function schemeRefToCanonical(scheme: string, ref: ParsedRef): ParsedRef | undefined {
  if (scheme === 'kjv' || ref.linkName) return ref;
  const v = versification(scheme);
  const parts: RefPart[] = [];
  let book: BookId | undefined;
  for (const part of ref.parts) {
    const from = v.toCanonical({ book: ref.book, chapter: part.chapter, verse: part.verse ?? 1 });
    if (!from) continue;
    book = from.book;
    if (part.verse === undefined) {
      parts.push({ chapter: from.chapter });
      continue;
    }
    const endLoc = { book: ref.book, chapter: part.endChapter ?? part.chapter, verse: part.endVerse ?? part.verse };
    const to = part.endVerse === undefined && part.endChapter === undefined ? from : (v.toCanonical(endLoc) ?? from);
    if (to.chapter === from.chapter && to.verse === from.verse) parts.push({ chapter: from.chapter, verse: from.verse });
    else if (to.chapter === from.chapter) parts.push({ chapter: from.chapter, verse: from.verse, endVerse: to.verse });
    else parts.push({ chapter: from.chapter, verse: from.verse, endChapter: to.chapter, endVerse: to.verse });
  }
  return book && parts.length ? { book, parts } : undefined;
}

export function isBook(id: string): id is AnyBookId {
  return isBookId(id);
}
