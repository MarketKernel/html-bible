/**
 * Verse references: reading them and writing them.
 *
 * Two written forms come in:
 *  - the readable link: Synodal_Mat3-3, Synodal_Mat5-3,5,7-9, KJV_Jhn3,
 *    Synodal_Mat3-16~4-2 (across chapters), Mat3-3 (no translation);
 *  - free form, as people write: «Мф 2:3», «Ин 3:16-18», «1 Кор 13:4», «Мф 2,3»
 *    (the Russian comma), "John 3:16", "Ps 23", "Matt 3:16-4:2".
 *
 * Both give a ParsedRef: a book and parts in the numbering of whatever
 * translation the reference was written for. Converting to canonical keys is
 * versification's business (canon.ts), not this module's.
 */

import { type AnyBookId, bookInfo, findBook } from './books';
import type { Lang } from './types';

export interface RefPart {
  chapter: number;
  /** Absent: the whole chapter. */
  verse?: number;
  /** A range's end; endChapter only when it crosses into another chapter. */
  endChapter?: number;
  endVerse?: number;
}

export interface ParsedRef {
  /** The translation's linkName, when the reference names one. */
  linkName?: string;
  book: AnyBookId;
  parts: RefPart[];
}

const positive = (text: string | undefined): number | undefined => {
  if (!text || !/^\d{1,3}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 ? n : undefined;
};

/** "3,5,7-9" in chapter c → parts; undefined if malformed or a range runs backwards. */
function verseList(chapter: number, list: string): RefPart[] | undefined {
  const parts: RefPart[] = [];
  for (const item of list.split(',')) {
    const [a, b, extra] = item.split(/[-–—]/).map((s) => s.trim());
    if (extra !== undefined) return undefined;
    const verse = positive(a);
    if (verse === undefined) return undefined;
    if (b === undefined) {
      parts.push({ chapter, verse });
      continue;
    }
    const endVerse = positive(b);
    if (endVerse === undefined || endVerse < verse) return undefined;
    parts.push(endVerse === verse ? { chapter, verse } : { chapter, verse, endVerse });
  }
  return parts.length ? parts : undefined;
}

const LINK = /^(?:([A-Za-z][A-Za-z0-9]*)_)?([1-3]?[A-Za-z]+)(\d{1,3})(?:-([\d,-]+))?(?:~(\d{1,3})-(\d{1,3}))?$/;

/** Synodal_Mat3-3 and its kin; undefined when the text is not one. */
export function parseLink(text: string): ParsedRef | undefined {
  const match = LINK.exec(text.trim());
  if (!match) return undefined;
  const [, linkName, bookText, chapterText, verses, endChapterText, endVerseText] = match;
  const book = findBook(bookText ?? '');
  const chapter = positive(chapterText);
  if (!book || chapter === undefined) return undefined;
  let parts: RefPart[] | undefined;
  if (endChapterText !== undefined) {
    // Across chapters: one verse to one verse, nothing else allowed with it.
    const verse = positive(verses);
    const endChapter = positive(endChapterText);
    const endVerse = positive(endVerseText);
    if (verse === undefined || endChapter === undefined || endVerse === undefined || endChapter <= chapter) return undefined;
    parts = [{ chapter, verse, endChapter, endVerse }];
  } else if (verses !== undefined) {
    parts = verseList(chapter, verses);
  } else {
    parts = [{ chapter }];
  }
  if (!parts) return undefined;
  return linkName ? { linkName, book, parts } : { book, parts };
}

/**
 * «Мф 2:3», «Ин 3:16-18», «Мф 5:3,5,7», «Мф 2,3», «1 Кор 13», "Matt 3:16-4:2".
 * Several references separated by «;» are not handled here (see parseRefs).
 */
export function parseFree(text: string): ParsedRef | undefined {
  const match = /^\s*((?:[1-3]|I{1,3})?\s*[^\d\s:;,.][^\d:;]*?)\.?\s*(\d{1,3})(?:\s*([:,.])\s*([\d\s,–—:-]+?))?\s*$/i.exec(text);
  if (!match) return undefined;
  const [, bookText, chapterText, separator, rest] = match;
  const book = findBook(bookText ?? '');
  const chapter = positive(chapterText);
  if (!book || chapter === undefined) return undefined;
  if (rest === undefined) return { book, parts: [{ chapter }] };
  const list = rest.replace(/\s+/g, '');
  // Across chapters: 3:16-4:2
  const cross = /^(\d{1,3})[-–—](\d{1,3}):(\d{1,3})$/.exec(list);
  if (cross && separator === ':') {
    const verse = positive(cross[1]);
    const endChapter = positive(cross[2]);
    const endVerse = positive(cross[3]);
    if (verse === undefined || endChapter === undefined || endVerse === undefined || endChapter <= chapter) return undefined;
    return { book, parts: [{ chapter, verse, endChapter, endVerse }] };
  }
  if (list.includes(':')) return undefined;
  const parts = verseList(chapter, list);
  return parts ? { book, parts } : undefined;
}

/** A readable link or free form — what the address bar, search and links accept. */
export function parseRef(text: string): ParsedRef | undefined {
  return parseLink(text) ?? parseFree(text);
}

/** «Ин 3:16; Рим 5:8» → each reference; undefined if any part is not one. */
export function parseRefs(text: string): ParsedRef[] | undefined {
  const pieces = text.split(';').map((s) => s.trim()).filter(Boolean);
  if (!pieces.length) return undefined;
  const refs: ParsedRef[] = [];
  for (const piece of pieces) {
    const ref = parseRef(piece);
    if (!ref) return undefined;
    refs.push(ref);
  }
  return refs;
}

/* ---------------- writing ---------------- */

function partsText(parts: RefPart[], chapterVerse: string, range: string): string {
  // Group consecutive parts of the same chapter: 5:3,5,7-9
  const out: string[] = [];
  let lastChapter: number | undefined;
  for (const part of parts) {
    let text: string;
    if (part.verse === undefined) text = String(part.chapter);
    else if (part.endChapter !== undefined) text = `${part.chapter}${chapterVerse}${part.verse}${range}${part.endChapter}${chapterVerse}${part.endVerse}`;
    else {
      const verses = part.endVerse !== undefined ? `${part.verse}${range}${part.endVerse}` : String(part.verse);
      text = lastChapter === part.chapter ? verses : `${part.chapter}${chapterVerse}${verses}`;
    }
    out.push(text);
    lastChapter = part.verse === undefined || part.endChapter !== undefined ? undefined : part.chapter;
  }
  return out.join(',');
}

/** Synodal_Mat3-3 — the canonical spelling of a readable link. */
export function formatLink(ref: ParsedRef): string {
  const book = bookInfo(ref.book)?.link ?? ref.book;
  const prefix = ref.linkName ? `${ref.linkName}_` : '';
  const [first] = ref.parts;
  if (!first) return `${prefix}${book}`;
  if (first.endChapter !== undefined) return `${prefix}${book}${first.chapter}-${first.verse}~${first.endChapter}-${first.endVerse}`;
  if (first.verse === undefined) return `${prefix}${book}${first.chapter}`;
  // A link holds one chapter; parts of others are left out.
  const verses = ref.parts
    .filter((p) => p.chapter === first.chapter && p.verse !== undefined && p.endChapter === undefined)
    .map((p) => (p.endVerse !== undefined ? `${p.verse}-${p.endVerse}` : String(p.verse)))
    .join(',');
  return `${prefix}${book}${first.chapter}-${verses}`;
}

/**
 * «Мф 3:3», "Matt 3:16-18" — for people. `bookName` overrides the book's
 * name, for a translation in a language books.ts has no names in.
 */
export function formatHuman(ref: Pick<ParsedRef, 'book' | 'parts'>, lang: Lang, form: 'short' | 'name' = 'short', bookName?: string): string {
  const info = bookInfo(ref.book);
  const name = bookName ?? (info ? info[lang][form] : ref.book);
  return `${name} ${partsText(ref.parts, ':', '–')}`;
}

/** Every verse of the parts that lie in one chapter, given that chapter's verse count. */
export function versesInChapter(parts: RefPart[], chapter: number, count: number): number[] {
  const verses = new Set<number>();
  for (const part of parts) {
    const endChapter = part.endChapter ?? part.chapter;
    if (chapter < part.chapter || chapter > endChapter) continue;
    if (part.verse === undefined) {
      for (let v = 1; v <= count; v += 1) verses.add(v);
      continue;
    }
    const from = chapter === part.chapter ? part.verse : 1;
    const to = part.endChapter !== undefined ? (chapter === endChapter ? (part.endVerse ?? count) : count) : (part.endVerse ?? part.verse);
    for (let v = from; v <= Math.min(to, count); v += 1) verses.add(v);
  }
  return [...verses].sort((a, b) => a - b);
}

/** Selected verses of one chapter → parts: [3,4,5,7] → 3-5, 7. */
export function partsFromVerses(chapter: number, verses: number[]): RefPart[] {
  const sorted = [...new Set(verses)].sort((a, b) => a - b);
  const parts: RefPart[] = [];
  for (const verse of sorted) {
    const last = parts.at(-1);
    const lastEnd = last ? (last.endVerse ?? last.verse ?? 0) : 0;
    if (last && verse === lastEnd + 1) last.endVerse = verse;
    else parts.push({ chapter, verse });
  }
  return parts;
}

/* ---------------- references inside text ---------------- */

export interface FoundRef {
  index: number;
  length: number;
  ref: ParsedRef;
}

// A book name (with an optional leading number), a chapter, a colon or a comma and verses.
const IN_TEXT = /(?:^|(?<=[\s(«"„[—–-]))((?:[1-3]\s?)?[A-ZА-ЯЁ][a-zа-яё]{0,14}\.?)\s?(\d{1,3})(?::|,\s?(?=\d))(\d{1,3}(?:\s?[-–]\s?\d{1,3})?(?:,\s?\d{1,3}(?:\s?[-–]\s?\d{1,3})?)*)/gu;

/** «… как сказано в Ин 3:16 и Рим 5:8» → both references with their places. */
export function findRefsInText(text: string): FoundRef[] {
  const found: FoundRef[] = [];
  for (const match of text.matchAll(IN_TEXT)) {
    const [whole, bookText, chapter, verses] = match;
    if (!bookText || !chapter || !verses || match.index === undefined) continue;
    const book = findBook(bookText);
    if (!book) continue;
    const parts = verseList(Number(chapter), verses.replace(/\s/g, ''));
    if (!parts) continue;
    found.push({ index: match.index, length: whole.length, ref: { book, parts } });
  }
  return found;
}
