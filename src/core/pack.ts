/**
 * Checking translation and commentary files before they are stored.
 *
 * A file can come from anywhere — the catalog, a friend, a hand-edited JSON —
 * so nothing is trusted: the format, the book ids, the shape of every chapter.
 * A bad file gives one clear message, not a blank page later. The same code
 * runs in the page and in tools/ (the build of data/).
 */

import { isBookId, isCanonicalBook } from './books';
import { t } from './i18n';
import type { Catalog, Commentary, CommentaryBook, CommentaryEntry, Translation } from './types';

export class PackError extends Error {}

const fail = (message: string): never => {
  throw new PackError(message);
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const LINK_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const RANGE = /^(\d{1,3})\.(\d{1,3})-(\d{1,3})\.(\d{1,3})$/;
const KEY = /^([1-3A-Z]{3})\.(\d{1,3})\.(\d{1,3})$/;

export type PackFile =
  | { kind: 'translation'; value: Translation }
  | { kind: 'commentary'; value: Commentary }
  | { kind: 'commentary-book'; value: CommentaryBook }
  | { kind: 'catalog'; value: Catalog };

/** What a parsed JSON file is, checked; throws PackError. */
export function identify(json: unknown): PackFile {
  if (!isObject(json)) return fail(t('pack', 'The file is not a translation or a commentary.'));
  switch (json.format) {
    case 'html-bible/translation':
      return { kind: 'translation', value: checkTranslation(json) };
    case 'html-bible/commentary':
      return { kind: 'commentary', value: checkCommentary(json) };
    case 'html-bible/commentary-book':
      return { kind: 'commentary-book', value: checkCommentaryBook(json) };
    case 'html-bible/catalog':
      return { kind: 'catalog', value: checkCatalog(json) };
    default:
      return fail(t('pack', 'The file is not a translation or a commentary.'));
  }
}

function checkVersion(json: Record<string, unknown>): void {
  if (json.formatVersion !== 1) fail(t('pack', 'This file was made for a newer version of the app.'));
}

export function checkTranslation(json: unknown, noncanonicalOf?: (scheme: string, book: string) => string[] | undefined): Translation {
  if (!isObject(json) || json.format !== 'html-bible/translation') return fail(t('pack', 'The file is not a translation or a commentary.'));
  checkVersion(json);
  for (const field of ['id', 'linkName', 'version', 'lang', 'name', 'shortName', 'license', 'versification'] as const) {
    if (typeof json[field] !== 'string') fail(t('pack', 'The translation has no “{field}”.', { field }));
  }
  if (!ID.test(json.id as string)) fail(t('pack', 'The translation’s id is not valid.'));
  if (!LINK_NAME.test(json.linkName as string)) fail(t('pack', 'The translation’s link name must be Latin letters and digits.'));
  if (!Array.isArray(json.books) || !json.books.length) return fail(t('pack', 'The translation has no books.'));
  const seen = new Set<string>();
  for (const book of json.books as unknown[]) {
    if (!isObject(book) || typeof book.id !== 'string' || !isBookId(book.id)) return fail(t('pack', 'Unknown book: {book}.', { book: String(isObject(book) ? book.id : book) }));
    if (seen.has(book.id)) fail(t('pack', 'The book {book} is there twice.', { book: book.id }));
    seen.add(book.id);
    if (!isText(book.name) || !isText(book.short)) fail(t('pack', 'The book {book} has no name.', { book: book.id }));
    if (book.aliases !== undefined && (!Array.isArray(book.aliases) || !book.aliases.every((a) => isText(a)))) fail(t('pack', 'The book {book} has bad aliases.', { book: book.id }));
    if (book.canonical !== undefined && typeof book.canonical !== 'boolean') fail(t('pack', 'The book {book} has a bad “canonical”.', { book: book.id }));
    if (book.canonical !== false && !isCanonicalBook(book.id)) fail(t('pack', 'The book {book} must be marked noncanonical.', { book: book.id }));
    if (!Array.isArray(book.chapters) || !book.chapters.length) return fail(t('pack', 'The book {book} has no chapters.', { book: book.id }));
    for (const chapter of book.chapters as unknown[]) {
      if (!Array.isArray(chapter) || !chapter.length || !chapter.every((verse) => typeof verse === 'string' && verse.length <= 5000)) {
        fail(t('pack', 'A chapter of {book} is broken.', { book: book.id }));
      }
    }
    if (book.noncanonical !== undefined) {
      if (!Array.isArray(book.noncanonical) || !book.noncanonical.every((r) => typeof r === 'string' && RANGE.test(r))) {
        fail(t('pack', 'The book {book} has bad noncanonical ranges.', { book: book.id }));
      }
      const expected = noncanonicalOf?.(json.versification as string, book.id);
      if (expected && JSON.stringify(expected) !== JSON.stringify(book.noncanonical)) {
        fail(t('pack', 'The noncanonical ranges of {book} differ from the versification table.', { book: book.id }));
      }
    }
  }
  return json as unknown as Translation;
}

/** "JHN.3.16" or "JHN.3.16-JHN.3.18", canonical books only. */
export function isCanonicalRef(ref: string): boolean {
  const [from, to, extra] = ref.split('-');
  if (!from || extra !== undefined) return false;
  const a = KEY.exec(from);
  if (!a || !isCanonicalBook(a[1]!) || Number(a[2]) < 1 || Number(a[3]) < 1) return false;
  if (to === undefined) return true;
  const b = KEY.exec(to);
  if (!b || !isCanonicalBook(b[1]!) || b[1] !== a[1] || Number(b[2]) < 1 || Number(b[3]) < 1) return false;
  return Number(b[2]) > Number(a[2]) || (Number(b[2]) === Number(a[2]) && Number(b[3]) >= Number(a[3]));
}

function checkEntries(entries: unknown, where: string): CommentaryEntry[] {
  if (!Array.isArray(entries)) return fail(t('pack', 'The commentary has no entries.'));
  for (const entry of entries as unknown[]) {
    if (!isObject(entry) || typeof entry.ref !== 'string' || typeof entry.md !== 'string') fail(t('pack', 'A commentary entry is broken ({where}).', { where }));
    const e = entry as Record<string, unknown>;
    if (!isCanonicalRef(e.ref as string)) fail(t('pack', 'A commentary entry has a bad reference: {ref}.', { ref: String(e.ref).slice(0, 40) }));
    if ((e.md as string).length > 200_000) fail(t('pack', 'A commentary entry is too long.'));
    if (e.id !== undefined && !(typeof e.id === 'string' && ID.test(e.id))) fail(t('pack', 'A commentary entry has a bad id.'));
  }
  return entries as CommentaryEntry[];
}

export function checkCommentary(json: unknown): Commentary {
  if (!isObject(json) || json.format !== 'html-bible/commentary') return fail(t('pack', 'The file is not a translation or a commentary.'));
  checkVersion(json);
  for (const field of ['id', 'version', 'lang', 'name'] as const) {
    if (typeof json[field] !== 'string') fail(t('pack', 'The commentary has no “{field}”.', { field }));
  }
  if (!ID.test(json.id as string)) fail(t('pack', 'The commentary’s id is not valid.'));
  if (json.versification !== undefined && !(typeof json.versification === 'string' && /^[a-z]{1,20}$/.test(json.versification))) fail(t('pack', 'The commentary has no “{field}”.', { field: 'versification' }));
  if (json.entries === undefined && json.books === undefined) fail(t('pack', 'The commentary has no entries.'));
  if (json.entries !== undefined) checkEntries(json.entries, json.id as string);
  if (json.books !== undefined) {
    if (!Array.isArray(json.books)) return fail(t('pack', 'The commentary’s book list is broken.'));
    for (const book of json.books as unknown[]) {
      if (!isObject(book) || typeof book.id !== 'string' || !isCanonicalBook(book.id) || typeof book.url !== 'string' || !/^[\w./-]+$/.test(book.url) || book.url.includes('..')) {
        fail(t('pack', 'The commentary’s book list is broken.'));
      }
    }
  }
  return json as unknown as Commentary;
}

export function checkCommentaryBook(json: unknown): CommentaryBook {
  if (!isObject(json) || json.format !== 'html-bible/commentary-book') return fail(t('pack', 'The file is not a translation or a commentary.'));
  checkVersion(json);
  if (typeof json.book !== 'string' || !isCanonicalBook(json.book)) fail(t('pack', 'Unknown book: {book}.', { book: String(json.book) }));
  checkEntries(json.entries, String(json.book));
  return json as unknown as CommentaryBook;
}

export function checkCatalog(json: unknown): Catalog {
  if (!isObject(json) || json.format !== 'html-bible/catalog') return fail(t('pack', 'The catalog is broken.'));
  checkVersion(json);
  if (!Array.isArray(json.translations) || !Array.isArray(json.commentaries)) fail(t('pack', 'The catalog is broken.'));
  const relative = (url: unknown) => typeof url === 'string' && /^[\w./-]+$/.test(url) && !url.includes('..');
  for (const item of json.translations as unknown[]) {
    if (!isObject(item) || !ID.test(String(item.id)) || !relative(item.url) || typeof item.name !== 'string') fail(t('pack', 'The catalog is broken.'));
  }
  for (const item of json.commentaries as unknown[]) {
    if (!isObject(item) || !ID.test(String(item.id)) || !relative(item.manifest) || typeof item.name !== 'string') fail(t('pack', 'The catalog is broken.'));
  }
  return json as unknown as Catalog;
}
