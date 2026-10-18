/**
 * Shared bits of the translation converters: book metadata from
 * src/core/books.ts, writing a gzipped translation, a short report.
 *
 * Not a CLI: imported by build-kjv.mjs, build-synodal.mjs and validate.mjs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { load, root } from '../load.mjs';

export { root };

export const books = await load('core/books');

/** name, short, aliases of a book in one language, as books.ts has them. */
export function bookMeta(id, lang) {
  const info = books.bookInfo(id);
  if (!info) throw new Error(`unknown book ${id}`);
  const { name, short, aliases } = info[lang];
  return { name, short, aliases: [...aliases] };
}

export function writeTranslation(file, translation) {
  mkdirSync(dirname(file), { recursive: true });
  // mtime 0 in the gzip header (Node's default) keeps the output byte-stable.
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(translation), 'utf8'), { level: 9 }));
}

export function readTranslation(file) {
  const raw = readFileSync(file);
  const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
  return JSON.parse(text);
}

export function counts(translation) {
  let chapters = 0;
  let verses = 0;
  for (const book of translation.books) {
    chapters += book.chapters.length;
    for (const chapter of book.chapters) verses += chapter.length;
  }
  return { books: translation.books.length, chapters, verses };
}

export const dataDir = join(root, 'data');
export const sourcesDir = join(root, 'private', 'sources');

/** First characters of a text, for reports that must stay short. */
export const clip = (text, n = 120) => (text.length > n ? `${text.slice(0, n)}…` : text);
