/**
 * Full-text search over one translation.
 *
 * A straight pass over every verse, normalized once: ~31–37 thousand short
 * strings take 10–30 ms, which needs no index. Each normalized verse is kept
 * as " word word … " so the start of a word is includes(" w") and an exact
 * word or phrase includes(" a b ").
 *
 * Query language: words match the start of a word, so a part is enough
 * («ипоста» finds «ипостаси»; Russian endings need no stemmer); all must be
 * there. "In quotes" — exactly that word or phrase. -word — leaves out verses
 * with a word starting so. A trailing * is accepted and means the same as
 * nothing.
 */

import { type AnyBookId, bookInfo } from './books';
import type { Translation, VerseLoc } from './types';

/** Lower case, ё → е, no diacritics or apostrophes, punctuation → space. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface Query {
  /** Starts of words. */
  words: string[];
  /** Exact words and phrases (in quotes). */
  phrases: string[];
  /** Starts of words that must not be there. */
  not: string[];
}

export function parseQuery(text: string): Query {
  const query: Query = { words: [], phrases: [], not: [] };
  const rest = text.replace(/["«»“”„]([^"«»“”„]+)["«»“”„]/g, (_, phrase: string) => {
    const norm = normalize(phrase);
    if (norm) query.phrases.push(norm);
    return ' ';
  });
  for (const raw of rest.split(/\s+/).filter(Boolean)) {
    const negative = raw.startsWith('-') && raw.length > 1;
    const norm = normalize(raw);
    if (!norm) continue;
    // "1Кор" → "1кор": one token; "Иисус-Христос" → two words
    const tokens = norm.split(' ');
    (negative ? query.not : query.words).push(...tokens);
  }
  return query;
}

export function isEmptyQuery(query: Query): boolean {
  return !query.words.length && !query.phrases.length;
}

export interface IndexEntry extends VerseLoc {
  norm: string;
  noncanonical: boolean;
}

export interface SearchIndex {
  translation: string;
  entries: IndexEntry[];
}

export function buildIndex(translation: Translation, isNoncanonical: (loc: VerseLoc) => boolean): SearchIndex {
  const entries: IndexEntry[] = [];
  for (const book of translation.books) {
    book.chapters.forEach((verses, c) => {
      verses.forEach((text, v) => {
        if (!text) return;
        const loc = { book: book.id, chapter: c + 1, verse: v + 1 };
        entries.push({ ...loc, norm: ` ${normalize(text)} `, noncanonical: book.canonical === false || isNoncanonical(loc) });
      });
    });
  }
  return { translation: translation.id, entries };
}

export interface SearchFilter {
  /** OT, NT, or a set of books. */
  testament?: 'OT' | 'NT';
  books?: ReadonlySet<AnyBookId>;
  includeNoncanonical: boolean;
}

export interface SearchResult {
  total: number;
  hits: VerseLoc[];
  /** Hits per book, in the order found. */
  byBook: Map<AnyBookId, number>;
}

export function matches(norm: string, query: Query): boolean {
  for (const word of query.words) if (!norm.includes(` ${word}`)) return false;
  for (const phrase of query.phrases) if (!norm.includes(` ${phrase} `)) return false;
  for (const word of query.not) if (norm.includes(` ${word}`)) return false;
  return true;
}

export function search(index: SearchIndex, query: Query, filter: SearchFilter): SearchResult {
  const hits: VerseLoc[] = [];
  const byBook = new Map<AnyBookId, number>();
  if (isEmptyQuery(query)) return { total: 0, hits, byBook };
  for (const entry of index.entries) {
    if (entry.noncanonical && !filter.includeNoncanonical) continue;
    if (filter.books && !filter.books.has(entry.book)) continue;
    if (filter.testament && bookInfo(entry.book)?.testament !== filter.testament) continue;
    if (!matches(entry.norm, query)) continue;
    hits.push({ book: entry.book, chapter: entry.chapter, verse: entry.verse });
    byBook.set(entry.book, (byBook.get(entry.book) ?? 0) + 1);
  }
  return { total: hits.length, hits, byBook };
}

/** Where to highlight in the original text: [start, end) of each word the query matched. */
export function highlights(text: string, query: Query): [number, number][] {
  const phraseWords = new Set(query.phrases.flatMap((p) => p.split(' ')));
  const out: [number, number][] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}'’ʼ]+/gu)) {
    const word = normalize(match[0]);
    if (!word || match.index === undefined) continue;
    const hit = phraseWords.has(word) || query.words.some((w) => word.startsWith(w));
    if (hit) out.push([match.index, match.index + match[0].length]);
  }
  return out;
}
