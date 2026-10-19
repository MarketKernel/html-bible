/**
 * English translations from eBible.org USFM in KJV versification →
 * data/translations/<id>.json.gz, one edition per run.
 *
 * Sources (all public domain), for each edition below:
 *   mkdir -p private/sources/ebible-<source>
 *   curl -L -o private/sources/ebible-<source>/<source>_usfm.zip https://ebible.org/Scriptures/<source>_usfm.zip
 *   unzip -o private/sources/ebible-<source>/<source>_usfm.zip -d private/sources/ebible-<source>/x
 * Run:
 *   node tools/translations/build-ebible.mjs asv|bsb|darby|web|ylt
 *
 * The versification is 'kjv', which the app treats as identity, so every
 * chapter must have exactly the KJV's verses: the converter fails otherwise.
 * Text as in build-kjv.mjs: \add → [ … ], a Psalm title opens verse 1,
 * footnotes, headings and Strong's numbers dropped. Verses a critical text
 * leaves out (Matt 17:21, Acts 8:37…) stay empty, as the editions print them.
 */
import { join } from 'node:path';
import { load } from '../load.mjs';
import { bookMeta, books, clip, counts, dataDir, sourcesDir, writeTranslation } from './common.mjs';
import { balanceChapter, flattenBrackets, normalizeSpace, readUsfmDir } from './usfm.mjs';
import { validateTranslation } from './validate.mjs';

const EDITIONS = {
  asv: { source: 'eng-asv', id: 'en-asv', linkName: 'ASV', name: 'American Standard Version', shortName: 'ASV', year: 1901 },
  bsb: { source: 'engbsb', id: 'en-bsb', linkName: 'BSB', name: 'Berean Standard Bible', shortName: 'BSB', year: 2022 },
  darby: { source: 'engDBY', id: 'en-darby', linkName: 'Darby', name: 'Darby Translation', shortName: 'Darby', year: 1890 },
  // The WEB prints the doxology of Romans as 14:24–26 and leaves 16:25 empty;
  // the KJV has it as 16:25–27, so it moves there.
  web: { source: 'engwebp', id: 'en-web', linkName: 'WEB', name: 'World English Bible', shortName: 'WEB', year: 2020, moves: [['ROM', 14, 24, 16, 25, 3]] },
  ylt: { source: 'engylt', id: 'en-ylt', linkName: 'YLT', name: 'Young’s Literal Translation', shortName: 'YLT', year: 1898 },
};

const { KJV_COUNTS } = await load('core/versification/kjv-counts');

const edition = EDITIONS[process.argv[2]];
if (!edition) throw new Error(`which edition: ${Object.keys(EDITIONS).join(', ')}`);
const dir = process.argv[3] ?? join(sourcesDir, `ebible-${edition.source}`, 'x');
const usfm = readUsfmDir(dir);

const out = [];
for (const id of books.CANONICAL_BOOKS) {
  const book = usfm.get(id);
  if (!book) throw new Error(`${edition.source} has no ${id}`);
  const chapters = book.chapters.map((verses, c) => {
    const title = book.titles.get(c + 1);
    return verses.map((text, v) => normalizeSpace(`${v === 0 && title ? `${title} ` : ''}${text}`.replace(/¶/g, ' ')));
  });
  out.push({ id, ...bookMeta(id, 'en'), chapters });
}

for (const [id, fromChapter, fromVerse, toChapter, toVerse, n] of edition.moves ?? []) {
  const chapters = out.find((b) => b.id === id).chapters;
  const moved = chapters[fromChapter - 1].splice(fromVerse - 1, n);
  const target = chapters[toChapter - 1];
  if (target.slice(toVerse - 1).some(Boolean)) throw new Error(`${id} ${toChapter}:${toVerse}: the verses to move into are not empty`);
  target.splice(toVerse - 1, n, ...moved);
}

// Darby and YLT print their own [ ] for added words. Over several verses
// (Darby John 5:3–4, YLT 1 John 5:7–8, the ASV's John 7:53–8:11) the brackets
// mark a doubtful passage instead, which "hide added words" must not hide, so
// those are dropped; so is the ASV's "[Selah", never closed.
const brackets = { stray: [], unopened: [] };
for (const book of out) {
  book.chapters.forEach((verses, c) => {
    for (let v = 0; v < verses.length; v += 1) verses[v] = flattenBrackets(verses[v]);
    const report = balanceChapter(verses, { across: false });
    for (const kind of Object.keys(brackets)) brackets[kind].push(...report[kind].map((v) => `${book.id} ${c + 1}:${v}`));
  });
}

const translation = {
  format: 'html-bible/translation',
  formatVersion: 1,
  id: edition.id,
  linkName: edition.linkName,
  version: '1.0.0',
  lang: 'en',
  name: edition.name,
  shortName: edition.shortName,
  year: edition.year,
  license: 'Public domain',
  source: `https://ebible.org/Scriptures/${edition.source}_usfm.zip (eBible.org, ${edition.name}; public domain)`,
  versification: 'kjv',
  books: out,
};

const errors = validateTranslation(translation);
for (const book of out) {
  const want = KJV_COUNTS[book.id];
  if (book.chapters.length !== want.length) errors.push(`${book.id}: ${book.chapters.length} chapters, the KJV has ${want.length}`);
  book.chapters.forEach((chapter, c) => {
    if (chapter.length !== want[c]) errors.push(`${book.id} ${c + 1}: ${chapter.length} verses, the KJV has ${want[c]}`);
  });
}
const c = counts(translation);
const empty = out.flatMap((b) => b.chapters.flatMap((ch, ci) => ch.flatMap((t, vi) => (t ? [] : [`${b.id} ${ci + 1}:${vi + 1}`]))));
console.log(`${edition.shortName}: ${c.books} books, ${c.chapters} chapters, ${c.verses} verses, empty: ${empty.length} ${empty.slice(0, 5).join(' ')}`);
const list = (items) => (items.length ? `${items.length} ${items.slice(0, 4).join(', ')}${items.length > 4 ? ' …' : ''}` : '—');
console.log(`  brackets dropped — never closed in the verse: ${list(brackets.stray)}; never opened in it: ${list(brackets.unopened)}`);
if (errors.length) {
  for (const e of errors.slice(0, 30)) console.log(`  ${e}`);
  process.exit(1);
}
writeTranslation(join(dataDir, 'translations', `${edition.id}.json.gz`), translation);
for (const [id, cc, vv] of [['GEN', 1, 1], ['PSA', 23, 1], ['JHN', 3, 16]]) console.log(`  ${id} ${cc}:${vv} ${clip(out.find((b) => b.id === id).chapters[cc - 1][vv - 1])}`);
