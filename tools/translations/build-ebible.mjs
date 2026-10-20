/**
 * English translations and Greek New Testaments from eBible.org USFM in KJV
 * versification → data/translations/<id>.json.gz, one edition per run.
 *
 * Sources (all public domain), for each edition below:
 *   mkdir -p private/sources/ebible-<source>
 *   curl -L -o private/sources/ebible-<source>/<source>_usfm.zip https://ebible.org/Scriptures/<source>_usfm.zip
 *   unzip -o private/sources/ebible-<source>/<source>_usfm.zip -d private/sources/ebible-<source>/x
 * Run:
 *   node tools/translations/build-ebible.mjs asv|bsb|darby|web|ylt|pt|tr
 *
 * The versification is 'kjv', which the app treats as identity, so every
 * chapter must have exactly the KJV's verses: the converter fails otherwise.
 * Text as in build-kjv.mjs: \add → [ … ], a Psalm title opens verse 1,
 * footnotes, headings and Strong's numbers dropped. Verses a critical text
 * leaves out (Matt 17:21, Acts 8:37…) stay empty, as the editions print them.
 *
 * The Greek editions have the New Testament only, Greek book names, and no
 * added words: their [ ] and ⟦ ⟧ mark doubtful words of the text, which
 * "hide added words" must not hide, so the brackets go and the words stay.
 * Their \d is the subscription after an epistle (Πρὸς Ῥωμαίους ἐγράφη…), not
 * a title, so it is dropped.
 */
import { join } from 'node:path';
import { load } from '../load.mjs';
import { bookMeta, books, clip, counts, dataDir, GREEK_NAMES, sourcesDir, writeTranslation } from './common.mjs';
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
  // The Patriarchal text (Antoniades, Constantinople 1904) divides a few
  // verses otherwise: John 1:38 and Rev 15:8 in two, 2 Cor 13:12–13 in one,
  // 3 John 14 with a verse 15; the doxology of Romans as in the WEB.
  pt: {
    source: 'grcbyz', id: 'grc-pt1904', linkName: 'PT', name: 'Ἡ Καινὴ Διαθήκη — Πατριαρχικὴ ἔκδοσις 1904', shortName: 'PT', year: 1904, greek: true,
    merges: [['JHN', 1, 38], ['REV', 15, 8], ['3JN', 1, 14]],
    splits: [['2CO', 13, 12, 'ἀσπάζονται ὑμᾶς οἱ ἅγιοι']],
    moves: [['ROM', 14, 24, 16, 25, 3]],
  },
  // Collated from Stephanus 1550, Elzevir 1624 and Scrivener 1881; the KJV's own verses.
  tr: { source: 'grctr', id: 'grc-tr', linkName: 'TR', name: 'Ἡ Καινὴ Διαθήκη — Textus Receptus', shortName: 'TR', greek: true },
};

const { KJV_COUNTS } = await load('core/versification/kjv-counts');

const edition = EDITIONS[process.argv[2]];
if (!edition) throw new Error(`which edition: ${Object.keys(EDITIONS).join(', ')}`);
const dir = process.argv[3] ?? join(sourcesDir, `ebible-${edition.source}`, 'x');
const usfm = readUsfmDir(dir);

const out = [];
const ids = edition.greek ? books.CANONICAL_BOOKS.slice(books.CANONICAL_BOOKS.indexOf('MAT')) : books.CANONICAL_BOOKS;
for (const id of ids) {
  const book = usfm.get(id);
  if (!book) throw new Error(`${edition.source} has no ${id}`);
  const chapters = book.chapters.map((verses, c) => {
    const title = edition.greek ? undefined : book.titles.get(c + 1);
    return verses.map((text, v) => {
      const plain = edition.greek ? text.replace(/[[\]⟦⟧]/g, '') : text;
      return normalizeSpace(`${v === 0 && title ? `${title} ` : ''}${plain}`.replace(/¶/g, ' '));
    });
  });
  const [name, short] = edition.greek ? GREEK_NAMES[id] : [];
  out.push({ id, ...(edition.greek ? { name, short } : bookMeta(id, 'en')), chapters });
}
const chaptersOf = (id) => out.find((b) => b.id === id).chapters;

// A verse the edition divides in two: the second half joins the first.
for (const [id, chapter, verse] of edition.merges ?? []) {
  const verses = chaptersOf(id)[chapter - 1];
  const [second] = verses.splice(verse, 1);
  verses[verse - 1] = `${verses[verse - 1]} ${second}`;
}
// Two verses the edition prints as one: divided where the KJV's second begins.
for (const [id, chapter, verse, start] of edition.splits ?? []) {
  const verses = chaptersOf(id)[chapter - 1];
  const at = verses[verse - 1].indexOf(start);
  if (at <= 0) throw new Error(`${id} ${chapter}:${verse}: no "${start}" to divide at`);
  const text = verses[verse - 1];
  verses.splice(verse - 1, 1, text.slice(0, at).trim(), text.slice(at));
}

for (const [id, fromChapter, fromVerse, toChapter, toVerse, n] of edition.moves ?? []) {
  const chapters = chaptersOf(id);
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
  lang: edition.greek ? 'grc' : 'en',
  name: edition.name,
  shortName: edition.shortName,
  ...(edition.year ? { year: edition.year } : {}),
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
for (const [id, cc, vv] of edition.greek ? [['JHN', 1, 38], ['2CO', 13, 13], ['JHN', 3, 16]] : [['GEN', 1, 1], ['PSA', 23, 1], ['JHN', 3, 16]]) console.log(`  ${id} ${cc}:${vv} ${clip(out.find((b) => b.id === id).chapters[cc - 1][vv - 1])}`);
