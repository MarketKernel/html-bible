/**
 * The shapes shared by the whole app: translations and commentaries as their
 * JSON files hold them, verse references, the user's own comments.
 * Discussion types (the server's) live in api-types.ts.
 */

import type { AnyBookId, BookId } from './books';

export type Lang = 'ru' | 'en';

/** Canonical verse key, KJV numbering: "JHN.3.16". */
export type VerseKey = `${BookId}.${number}.${number}`;

/** A canonical range; a single verse has from === to. */
export interface RefRange {
  from: VerseKey;
  to: VerseKey;
}

/** A verse in a translation's own numbering. */
export interface VerseLoc {
  book: AnyBookId;
  chapter: number;
  verse: number;
}

/* ---------------- translations ---------------- */

export interface TranslationBook {
  id: AnyBookId;
  name: string;
  short: string;
  aliases?: string[];
  /** Default true; false for a deuterocanonical book. */
  canonical?: boolean;
  /** Noncanonical insertions in a canonical book, native numbering: "3.24-3.90". */
  noncanonical?: string[];
  /** chapters[c][v] is verse v+1 of chapter c+1; "" — the verse is missing. */
  chapters: string[][];
}

export interface Translation {
  format: 'html-bible/translation';
  formatVersion: 1;
  id: string;
  linkName: string;
  version: string;
  lang: string;
  name: string;
  shortName: string;
  year?: number;
  license: string;
  source?: string;
  versification: string;
  books: TranslationBook[];
}

/* ---------------- commentaries ---------------- */

export interface CommentaryEntry {
  /** Only the user's own comments carry an id. */
  id?: string;
  /** "JHN.3.16" or "JHN.3.16-JHN.3.18", canonical. */
  ref: string;
  md: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CommentaryBookFile {
  id: BookId;
  url: string;
  bytes: number;
  sha256: string;
  entries: number;
}

/** One file with every entry (an export, a small set) or a manifest of per-book files. */
export interface Commentary {
  format: 'html-bible/commentary';
  formatVersion: 1;
  id: string;
  version: string;
  lang: string;
  name: string;
  /** The numbering of references written inside the text ("Пс 90:11"); canonical (KJV) when absent. */
  versification?: string;
  author?: string;
  license?: string;
  source?: string;
  exportedAt?: string;
  entries?: CommentaryEntry[];
  books?: CommentaryBookFile[];
}

export interface CommentaryBook {
  format: 'html-bible/commentary-book';
  formatVersion: 1;
  commentary: string;
  book: BookId;
  entries: CommentaryEntry[];
}

/* ---------------- catalog ---------------- */

export interface CatalogTranslation {
  id: string;
  linkName: string;
  lang: string;
  name: string;
  shortName: string;
  version: string;
  url: string;
  bytes: number;
  sha256: string;
  license: string;
}

export interface CatalogCommentary {
  id: string;
  lang: string;
  name: string;
  version: string;
  manifest: string;
  bytes: number;
  license: string;
}

export interface Catalog {
  format: 'html-bible/catalog';
  formatVersion: 1;
  translations: CatalogTranslation[];
  commentaries: CatalogCommentary[];
}

/* ---------------- installed packs ---------------- */

export type PackKind = 'translation' | 'commentary';

/** What the app keeps about an installed translation or commentary. */
export interface PackMeta {
  id: string;
  kind: PackKind;
  name: string;
  shortName?: string;
  linkName?: string;
  lang: string;
  version: string;
  bytes: number;
  /** Catalog — can be updated and loads books on demand; file — opened by the user. */
  origin: 'catalog' | 'file';
  installedAt: string;
  /** A commentary's numbering of the references inside its text. */
  versification?: string;
  /** For a per-book commentary from the catalog: where its books are. */
  baseUrl?: string;
  books?: CommentaryBookFile[];
}

/* ---------------- the user's own comments ---------------- */

export interface MyComment {
  id: string;
  ref: RefRange;
  bodyMd: string;
  createdAt: string;
  updatedAt?: string;
}
