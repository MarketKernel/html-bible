/**
 * Dumps the Synodal → canonical (KJV) verse mapping as JSON on stdout, for
 * tools/commentaries/lopukhin.py (Python cannot import src/core directly).
 *
 *   node tools/commentaries/synodal-map.mjs > map.json
 *
 * Output: {
 *   synodal: { BOOK: [verses per chapter] }   — Synodal counts, canonical books only,
 *                                              from data/translations/ru-synodal.json.gz;
 *   kjv:     { BOOK: [verses per chapter] }   — KJV_COUNTS;
 *   map:     { "BOOK.c.v": ["BOOK.c.v", …] }  — toCanonicalAll for every Synodal
 *                                              verse whose answer is not the same
 *                                              key ([] = noncanonical insertion).
 * }
 * Verses not listed keep their number (the versification's own default).
 */
import { join } from 'node:path';
import { load } from '../load.mjs';
import { dataDir, readTranslation } from '../translations/common.mjs';

const { versification } = await load('core/versification/map');
const { KJV_COUNTS } = await load('core/versification/kjv-counts');
const { isCanonicalBook } = await load('core/books');

const syn = readTranslation(join(dataDir, 'translations', 'ru-synodal.json.gz'));
const v = versification('synodal');
const synodal = {};
const map = {};
for (const book of syn.books) {
  if (!isCanonicalBook(book.id)) continue;
  synodal[book.id] = book.chapters.map((c) => c.length);
  book.chapters.forEach((chapter, ci) => {
    for (let vi = 1; vi <= chapter.length; vi += 1) {
      const native = `${book.id}.${ci + 1}.${vi}`;
      const all = v.toCanonicalAll({ book: book.id, chapter: ci + 1, verse: vi }).map((k) => `${k.book}.${k.chapter}.${k.verse}`);
      if (all.length !== 1 || all[0] !== native) map[native] = all;
    }
  });
}
process.stdout.write(JSON.stringify({ synodal, kjv: KJV_COUNTS, map }));
