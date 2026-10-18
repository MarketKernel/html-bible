/**
 * tests/fixtures/data/ — what the browser test downloads, cut from data/: the
 * real data is not in git, and CI must still run the page end to end.
 *
 * Every book, chapter and verse is kept, so numbering, versification and the
 * noncanonical ranges are the real ones; only the chapters the test reads,
 * searches or discusses keep their text (in the rest every verse is "…").
 * Lopukhin keeps only John 3.
 *
 *   node tools/test-data.mjs
 *
 * Run after a format change, or when tests/app.mjs starts reading another
 * chapter (add it to KEEP). The output is committed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { needData, root } from './load.mjs';

needData('test data', 'translations/en-kjv.json.gz', 'translations/ru-synodal.json.gz', 'commentaries/ru-lopukhin/manifest.json');

// Chapters in each translation's own numbering. Psalms 22 and 23 cover both
// Synodal 22 = KJV 23; the rest are the reader, search ("ипоста", "любовь"),
// noncanonical and the seed discussion's verses (server/seed/trinity.json).
const KEEP = {
  GEN: [1], DEU: [6], PSA: [22, 23], DAN: [3], TOB: [1],
  MAT: [2, 28], MRK: [13], LUK: [1], JHN: [1, 3, 10, 14, 17, 20], ACT: [5], ROM: [5],
  '1CO': [8, 13], '2CO': [13], PHP: [2], COL: [2], '1TI': [2], HEB: [1], '1JN': [4],
};
const LOPUKHIN = /^JHN\.3\./;

const from = join(root, 'data');
const out = join(root, 'tests', 'fixtures', 'data');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'translations'), { recursive: true });
mkdirSync(join(out, 'commentaries', 'ru-lopukhin'), { recursive: true });

const gz = (value) => gzipSync(JSON.stringify(value), { level: 9 });
const readGz = (file) => JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));

for (const name of ['en-kjv.json.gz', 'ru-synodal.json.gz']) {
  const t = readGz(join(from, 'translations', name));
  t.books = t.books.map((book) => ({
    ...book,
    chapters: book.chapters.map((verses, c) => (KEEP[book.id]?.includes(c + 1) ? verses : verses.map(() => '…'))),
  }));
  writeFileSync(join(out, 'translations', name), gz(t));
}

const manifest = JSON.parse(readFileSync(join(from, 'commentaries', 'ru-lopukhin', 'manifest.json'), 'utf8'));
const john = readGz(join(from, 'commentaries', 'ru-lopukhin', 'JHN.json.gz'));
const bytes = gz({ ...john, entries: john.entries.filter((e) => LOPUKHIN.test(e.ref)) });
writeFileSync(join(out, 'commentaries', 'ru-lopukhin', 'JHN.json.gz'), bytes);
const book = { ...manifest.books.find((b) => b.id === 'JHN'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
book.entries = readGz(join(out, 'commentaries', 'ru-lopukhin', 'JHN.json.gz')).entries.length;
writeFileSync(join(out, 'commentaries', 'ru-lopukhin', 'manifest.json'), `${JSON.stringify({ ...manifest, books: [book] }, null, 2)}\n`);

execFileSync(process.execPath, [join(root, 'tools', 'translations', 'build-catalog.mjs'), out], { stdio: 'inherit' });
