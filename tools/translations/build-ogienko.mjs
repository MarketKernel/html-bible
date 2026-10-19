/**
 * The Ukrainian Bible translated by Ivan Ohienko (1962), from bolls.life,
 * in KJV versification → data/translations/uk-ogienko.json.gz.
 *
 * Source (CrossWire distributes the same translation as public domain,
 * module UkrOgienko; its text is fitted into SWORD's "Orthodox" scheme with
 * whole runs of verses merged into one, so bolls.life's copy, verse by verse
 * in the translation's own numbering, is the one converted):
 *   mkdir -p private/sources/bolls-ubio
 *   curl -L -o private/sources/bolls-ubio/UBIO.zip https://bolls.life/static/translations/UBIO.zip
 *   unzip -o private/sources/bolls-ubio/UBIO.zip -d private/sources/bolls-ubio/x
 * and the Paratext versification private/sources/ubsicap-vrs/eng.vrs, which
 * every renumbering below is checked against.
 * Run:
 *   node tools/translations/build-ogienko.mjs
 *
 * Ohienko numbers verses as the KJV does, except where he follows the Hebrew:
 * a Psalm title is a verse of its own (one or two), 1 Samuel 21:1 is the end
 * of the KJV's 20:42, and 3 John 15 is the end of the KJV's verse 14. These
 * are folded into the KJV's verses, so the versification is 'kjv' (identity);
 * any other chapter that differs from the KJV fails the conversion.
 *
 * Text: the four <i> of the source dropped with their markup (there are no
 * other added-word marks to match them), spaces normalized.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from '../load.mjs';
import { books, clip, counts, dataDir, readTranslation, sourcesDir, writeTranslation } from './common.mjs';
import { normalizeSpace } from './usfm.mjs';
import { validateTranslation } from './validate.mjs';

const { KJV_COUNTS } = await load('core/versification/kjv-counts');

const sourceFile = process.argv[2] ?? join(sourcesDir, 'bolls-ubio', 'x', 'UBIO.json');
const vrsFile = process.argv[3] ?? join(sourcesDir, 'ubsicap-vrs', 'eng.vrs');

/** id → [name, short]: Ohienko's names, shortened as Ukrainian editions do. */
const NAMES = {
  GEN: ['Буття', 'Бут'], EXO: ['Вихід', 'Вих'], LEV: ['Левит', 'Лев'], NUM: ['Числа', 'Чис'],
  DEU: ['Повторення Закону', 'Повт'], JOS: ['Ісус Навин', 'Нав'], JDG: ['Судді', 'Суд'], RUT: ['Рут', 'Рут'],
  '1SA': ['1 Самуїлова', '1Сам'], '2SA': ['2 Самуїлова', '2Сам'], '1KI': ['1 Царів', '1Цар'], '2KI': ['2 Царів', '2Цар'],
  '1CH': ['1 Хроніки', '1Хр'], '2CH': ['2 Хроніки', '2Хр'], EZR: ['Ездра', 'Езд'], NEH: ['Неемія', 'Неем'],
  EST: ['Естер', 'Ест'], JOB: ['Йов', 'Йов'], PSA: ['Псалми', 'Пс'], PRO: ['Приповісті', 'Прип'],
  ECC: ['Екклезіяст', 'Екл'], SNG: ['Пісня над піснями', 'Пісн'], ISA: ['Ісая', 'Іс'], JER: ['Єремія', 'Єр'],
  LAM: ['Плач Єремії', 'Плач'], EZK: ['Єзекіїль', 'Єз'], DAN: ['Даниїл', 'Дан'], HOS: ['Осія', 'Ос'],
  JOL: ['Йоїл', 'Йоїл'], AMO: ['Амос', 'Ам'], OBA: ['Овдій', 'Овд'], JON: ['Йона', 'Йона'],
  MIC: ['Михей', 'Мих'], NAM: ['Наум', 'Наум'], HAB: ['Авакум', 'Ав'], ZEP: ['Софонія', 'Соф'],
  HAG: ['Огій', 'Ог'], ZEC: ['Захарія', 'Зах'], MAL: ['Малахія', 'Мал'],
  MAT: ['Від Матвія', 'Мт'], MRK: ['Від Марка', 'Мк'], LUK: ['Від Луки', 'Лк'], JHN: ['Від Івана', 'Ів'],
  ACT: ['Дії', 'Дії'], ROM: ['До римлян', 'Рим'], '1CO': ['1 до коринтян', '1Кор'], '2CO': ['2 до коринтян', '2Кор'],
  GAL: ['До галатів', 'Гал'], EPH: ['До ефесян', 'Еф'], PHP: ['До филип’ян', 'Флп'], COL: ['До колоссян', 'Кол'],
  '1TH': ['1 до солунян', '1Сол'], '2TH': ['2 до солунян', '2Сол'], '1TI': ['1 Тимофію', '1Тим'], '2TI': ['2 Тимофію', '2Тим'],
  TIT: ['До Тита', 'Тит'], PHM: ['До Филимона', 'Флм'], HEB: ['До євреїв', 'Євр'], JAS: ['Якова', 'Як'],
  '1PE': ['1 Петра', '1Пет'], '2PE': ['2 Петра', '2Пет'], '1JN': ['1 Івана', '1Ів'], '2JN': ['2 Івана', '2Ів'],
  '3JN': ['3 Івана', '3Ів'], JUD: ['Юди', 'Юд'], REV: ['Об’явлення', 'Об'],
};

// The source: bolls.life numbers the books 1–66 in the KJV's order.
const source = new Map();
for (const { book, chapter, verse, text } of JSON.parse(readFileSync(sourceFile, 'utf8'))) {
  const id = books.CANONICAL_BOOKS[book - 1];
  if (!id) throw new Error(`unknown book number ${book}`);
  if (!source.has(id)) source.set(id, []);
  const chapters = source.get(id);
  chapters[chapter - 1] ??= [];
  chapters[chapter - 1][verse - 1] = normalizeSpace(text.replace(/<\/?i>/g, ''));
}

/**
 * Hebrew verse → English verse, from eng.vrs lines like "PSA 51:0 = PSA 51:1"
 * and "PSA 3:0-8 = PSA 3:1-9" (English on the left, verse 0 a title).
 */
const vrs = new Map();
for (const line of readFileSync(vrsFile, 'utf8').split('\n')) {
  const m = /^([1-3A-Z]{3}) (\d+):(\d+)(?:-(\d+))? = \1 (\d+):(\d+)(?:-(\d+))?\s*$/.exec(line);
  if (!m) continue;
  const [, id, ec, ev1, ev2 = ev1, hc, hv1, hv2 = hv1] = m;
  if (ev2 - ev1 !== hv2 - hv1) throw new Error(`eng.vrs: ranges of different length: ${line}`);
  for (let i = 0; i <= ev2 - ev1; i += 1) vrs.set(`${id} ${hc}:${Number(hv1) + i}`, `${id} ${ec}:${Number(ev1) + i}`);
}

const errors = [];
const folded = [];
const out = [];
for (const id of books.CANONICAL_BOOKS) {
  const chapters = source.get(id);
  const want = KJV_COUNTS[id];
  if (!chapters || chapters.length !== want.length) {
    errors.push(`${id}: ${chapters?.length ?? 0} chapters, the KJV has ${want.length}`);
    continue;
  }
  chapters.forEach((verses, c) => {
    if (verses.length !== [...verses].filter((v) => v !== undefined).length) errors.push(`${id} ${c + 1}: a verse missing in the source`);
  });
  const result = chapters.map((verses) => [...verses]);
  chapters.forEach((verses, c) => {
    const extra = verses.length - want[c];
    if (extra === 0) return;
    const here = `${id} ${c + 1}`;
    if (id === 'PSA' && (extra === 1 || extra === 2)) {
      // The title, as one or two verses, opens the KJV's verse 1.
      for (let v = 1; v <= extra; v += 1) {
        if (vrs.get(`PSA ${c + 1}:${v}`) !== `PSA ${c + 1}:0`) errors.push(`${here}:${v} is not a title in eng.vrs`);
      }
      const title = verses.slice(0, extra).join(' ');
      result[c] = verses.slice(extra);
      result[c][0] = `${title} ${result[c][0]}`;
    } else if (id === '1SA' && c === 20 && extra === 1) {
      if (vrs.get('1SA 21:1') !== '1SA 20:42') errors.push(`${here}:1 is not 20:42 in eng.vrs`);
      result[c - 1][want[c - 1] - 1] += ` ${verses[0]}`;
      result[c] = verses.slice(1);
    } else if (id === '3JN' && extra === 1) {
      // eng.vrs keeps verse 15 too; the KJV prints it as the end of 14.
      result[c] = verses.slice(0, -1);
      result[c][want[c] - 1] += ` ${verses.at(-1)}`;
    } else {
      errors.push(`${here}: ${verses.length} verses, the KJV has ${want[c]}, and no rule folds them`);
      return;
    }
    folded.push({ id, chapter: c + 1 });
  });
  const [name, short] = NAMES[id];
  out.push({ id, name, short, chapters: result });
}

const translation = {
  format: 'html-bible/translation',
  formatVersion: 1,
  id: 'uk-ogienko',
  linkName: 'Ogienko',
  version: '1.0.0',
  lang: 'uk',
  name: 'Біблія в перекладі Івана Огієнка',
  shortName: 'Огієнко',
  year: 1962,
  license: 'Public domain',
  source:
    'https://bolls.life/static/translations/UBIO.zip (bolls.life, Біблія в перекладі Івана Огієнка, 1962; distributed as public domain by CrossWire, module UkrOgienko)',
  versification: 'kjv',
  books: out,
};

errors.push(...validateTranslation(translation));
for (const book of out) {
  book.chapters.forEach((chapter, c) => {
    if (chapter.length !== KJV_COUNTS[book.id][c]) errors.push(`${book.id} ${c + 1}: ${chapter.length} verses after folding, the KJV has ${KJV_COUNTS[book.id][c]}`);
  });
}

// A shifted verse pairs texts of unrelated length: compare each verse's length
// with the KJV's and show the farthest from the usual ratio.
const kjv = Object.fromEntries(readTranslation(join(dataDir, 'translations', 'en-kjv.json.gz')).books.map((b) => [b.id, b.chapters]));
const ratios = [];
for (const book of out) {
  book.chapters.forEach((chapter, c) =>
    chapter.forEach((text, v) => {
      const en = kjv[book.id][c][v];
      if (text && en) ratios.push({ at: `${book.id} ${c + 1}:${v + 1}`, r: text.length / en.length, text, en });
    }),
  );
}
const median = ratios.map((x) => x.r).sort((a, b) => a - b)[ratios.length >> 1];
const worst = ratios.sort((a, b) => Math.abs(Math.log(b.r / median)) - Math.abs(Math.log(a.r / median))).slice(0, 4);

const c = counts(translation);
console.log(`Ohienko: ${c.books} books, ${c.chapters} chapters, ${c.verses} verses`);
const psalms = folded.filter((f) => f.id === 'PSA').map((f) => f.chapter);
console.log(`  folded into KJV verses: ${psalms.length} Psalms (${psalms.slice(0, 6).join(', ')} …), ${folded.filter((f) => f.id !== 'PSA').map((f) => `${f.id} ${f.chapter}`).join(', ')}`);
console.log(`  length against the KJV: median ${median.toFixed(2)}; farthest:`);
for (const w of worst) console.log(`    ${w.at} ×${(w.r / median).toFixed(2)}  ${clip(w.text, 50)} | ${clip(w.en, 40)}`);
if (errors.length) {
  for (const e of errors.slice(0, 30)) console.log(`  ${e}`);
  process.exit(1);
}
writeTranslation(join(dataDir, 'translations', 'uk-ogienko.json.gz'), translation);
for (const [id, cc, vv] of [['GEN', 1, 1], ['PSA', 23, 1], ['PSA', 51, 1], ['1SA', 20, 42], ['JHN', 3, 16]]) console.log(`  ${id} ${cc}:${vv} ${clip(out.find((b) => b.id === id).chapters[cc - 1][vv - 1])}`);
