/**
 * Shared bits of the translation converters: book metadata from
 * src/core/books.ts, writing a gzipped translation, a short report.
 *
 * Not a CLI: imported by the converters (build-*.mjs) and validate.mjs.
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

/** id → [name, short] of the New Testament in Greek: the titles Greek editions print, shortened as they cite them. */
export const GREEK_NAMES = {
  MAT: ['Κατὰ Ματθαῖον', 'Ματθ'], MRK: ['Κατὰ Μᾶρκον', 'Μάρκ'], LUK: ['Κατὰ Λουκᾶν', 'Λουκ'], JHN: ['Κατὰ Ἰωάννην', 'Ἰω'],
  ACT: ['Πράξεις τῶν Ἀποστόλων', 'Πράξ'], ROM: ['Πρὸς Ῥωμαίους', 'Ῥωμ'],
  '1CO': ['Πρὸς Κορινθίους Α΄', 'Α΄ Κορ'], '2CO': ['Πρὸς Κορινθίους Β΄', 'Β΄ Κορ'],
  GAL: ['Πρὸς Γαλάτας', 'Γαλ'], EPH: ['Πρὸς Ἐφεσίους', 'Ἐφ'], PHP: ['Πρὸς Φιλιππησίους', 'Φιλιπ'], COL: ['Πρὸς Κολοσσαεῖς', 'Κολ'],
  '1TH': ['Πρὸς Θεσσαλονικεῖς Α΄', 'Α΄ Θεσ'], '2TH': ['Πρὸς Θεσσαλονικεῖς Β΄', 'Β΄ Θεσ'],
  '1TI': ['Πρὸς Τιμόθεον Α΄', 'Α΄ Τιμ'], '2TI': ['Πρὸς Τιμόθεον Β΄', 'Β΄ Τιμ'],
  TIT: ['Πρὸς Τίτον', 'Τίτ'], PHM: ['Πρὸς Φιλήμονα', 'Φιλήμ'], HEB: ['Πρὸς Ἑβραίους', 'Ἑβρ'], JAS: ['Ἰακώβου', 'Ἰακ'],
  '1PE': ['Πέτρου Α΄', 'Α΄ Πέτ'], '2PE': ['Πέτρου Β΄', 'Β΄ Πέτ'],
  '1JN': ['Ἰωάννου Α΄', 'Α΄ Ἰω'], '2JN': ['Ἰωάννου Β΄', 'Β΄ Ἰω'], '3JN': ['Ἰωάννου Γ΄', 'Γ΄ Ἰω'],
  JUD: ['Ἰούδα', 'Ἰούδ'], REV: ['Ἀποκάλυψις Ἰωάννου', 'Ἀποκ'],
};

/** First characters of a text, for reports that must stay short. */
export const clip = (text, n = 120) => (text.length > n ? `${text.slice(0, n)}…` : text);
