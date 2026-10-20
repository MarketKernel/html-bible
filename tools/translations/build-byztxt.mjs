/**
 * The Greek New Testament in the Byzantine Textform, Robinson–Pierpont 2018,
 * in KJV versification → data/translations/grc-rp2018.json.gz.
 *
 * Source (public domain, the Unlicense): the editors' own repository, the
 * accented Unicode CSV without variants, pinned to one commit:
 *   mkdir -p private/sources/byztxt-rp2018
 *   for f in MAT MAR LUK JOH ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAM 1PE 2PE 1JO 2JO 3JO JUD REV; do
 *     curl -L -o private/sources/byztxt-rp2018/$f.csv https://raw.githubusercontent.com/byztxt/byzantine-majority-text/27a45ff1b7be6c17ccbfeac414f3f55732ae8e28/csv-unicode/ccat/no-variants/$f.csv
 *   done
 * eBible.org's grcmt is the same edition, but without accents, punctuation or
 * final sigma, so it is not the one converted.
 * Run:
 *   node tools/translations/build-byztxt.mjs
 *
 * New Testament only: the translation has the 27 books, and the reader opens
 * Matthew for an Old Testament link. The edition numbers verses as the KJV
 * does, except that it prints the doxology of Romans as 14:24–26 and leaves
 * 16:25–27 out; it moves there, as in the WEB. Verses the Byzantine text does
 * not have (Luke 17:36, Acts 8:37, 15:34, 24:7) stay empty; any other
 * difference from the KJV's shape fails the conversion.
 *
 * Text: ¶ (a new paragraph) dropped; a hyphen after a word, the edition's
 * mark of a parenthesis, becomes a spaced em dash; NFC, spaces normalized.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from '../load.mjs';
import { clip, counts, dataDir, GREEK_NAMES, sourcesDir, writeTranslation } from './common.mjs';
import { normalizeSpace } from './usfm.mjs';
import { validateTranslation } from './validate.mjs';

const { KJV_COUNTS } = await load('core/versification/kjv-counts');

const dir = process.argv[2] ?? join(sourcesDir, 'byztxt-rp2018');

/** id → the edition's file name. */
const FILES = {
  MAT: 'MAT', MRK: 'MAR', LUK: 'LUK', JHN: 'JOH', ACT: 'ACT', ROM: 'ROM', '1CO': '1CO', '2CO': '2CO', GAL: 'GAL',
  EPH: 'EPH', PHP: 'PHP', COL: 'COL', '1TH': '1TH', '2TH': '2TH', '1TI': '1TI', '2TI': '2TI', TIT: 'TIT', PHM: 'PHM',
  HEB: 'HEB', JAS: 'JAM', '1PE': '1PE', '2PE': '2PE', '1JN': '1JO', '2JN': '2JO', '3JN': '3JO', JUD: 'JUD', REV: 'REV',
};
const EMPTY = ['LUK 17:36', 'ACT 8:37', 'ACT 15:34', 'ACT 24:7'];

/** Rows of one book's CSV: chapter,verse,text, the text quoted when it has a comma (never a quote). */
function readCsv(file) {
  const lines = readFileSync(join(dir, `${file}.csv`), 'utf8').split('\n');
  if (lines[0] !== 'chapter,verse,text') throw new Error(`${file}.csv: header ${lines[0]}`);
  return lines.slice(1).filter(Boolean).map((line) => {
    const m = /^(\d+),(\d+),(?:"([^"]*)"|([^"]*))$/.exec(line);
    if (!m) throw new Error(`${file}.csv: ${clip(line, 60)}`);
    return { chapter: Number(m[1]), verse: Number(m[2]), text: m[3] ?? m[4] };
  });
}

const clean = (text) => normalizeSpace(text.normalize('NFC').replace(/¶/g, ' ').replace(/-(?=\s|$)/g, ' —'));

const errors = [];
const out = [];
for (const [id, file] of Object.entries(FILES)) {
  const [name, short] = GREEK_NAMES[id];
  const chapters = [];
  for (const { chapter, verse, text } of readCsv(file)) {
    const verses = (chapters[chapter - 1] ??= []);
    if (verses[verse - 1] !== undefined) errors.push(`${id} ${chapter}:${verse} twice`);
    verses[verse - 1] = clean(text);
  }
  out.push({ id, name, short, chapters });
}

// The doxology: ROM 14:24–26 → 16:25–27.
const rom = out.find((b) => b.id === 'ROM').chapters;
if (rom[13].length !== 26 || rom[15].length !== 24) errors.push(`ROM 14/16: ${rom[13].length}/${rom[15].length} verses, the doxology is not where expected`);
else rom[15].push(...rom[13].splice(23, 3));

const empty = [];
for (const book of out) {
  const want = KJV_COUNTS[book.id];
  if (book.chapters.length !== want.length) errors.push(`${book.id}: ${book.chapters.length} chapters, the KJV has ${want.length}`);
  book.chapters.forEach((verses, c) => {
    if (verses.length > want[c]) errors.push(`${book.id} ${c + 1}: ${verses.length} verses, the KJV has ${want[c]}`);
    for (let v = 0; v < want[c]; v += 1) {
      if (verses[v] === undefined) {
        verses[v] = '';
        empty.push(`${book.id} ${c + 1}:${v + 1}`);
      }
    }
  });
}
if (empty.join() !== EMPTY.join()) errors.push(`empty verses ${empty.join(', ')}, expected ${EMPTY.join(', ')}`);

const translation = {
  format: 'html-bible/translation',
  formatVersion: 1,
  id: 'grc-rp2018',
  linkName: 'RP',
  version: '1.0.0',
  lang: 'grc',
  name: 'Ἡ Καινὴ Διαθήκη — Robinson–Pierpont 2018',
  shortName: 'RP',
  year: 2018,
  license: 'Public domain',
  source:
    'https://github.com/byztxt/byzantine-majority-text (commit 27a45ff, csv-unicode/ccat/no-variants; The New Testament in the Original Greek: Byzantine Textform 2018, Maurice A. Robinson and William G. Pierpont; public domain)',
  versification: 'kjv',
  books: out,
};
errors.push(...validateTranslation(translation));

const c = counts(translation);
console.log(`RP 2018: ${c.books} books, ${c.chapters} chapters, ${c.verses} verses, empty: ${empty.length} ${empty.join(', ')}`);
if (errors.length) {
  for (const e of errors.slice(0, 30)) console.log(`  ${e}`);
  process.exit(1);
}
writeTranslation(join(dataDir, 'translations', `${translation.id}.json.gz`), translation);
for (const [id, cc, vv] of [['JHN', 3, 16], ['ROM', 16, 25], ['1CO', 7, 11]]) console.log(`  ${id} ${cc}:${vv} ${clip(out.find((b) => b.id === id).chapters[cc - 1][vv - 1])}`);
