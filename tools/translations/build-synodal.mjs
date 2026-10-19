/**
 * Russian Synodal (1876) from the CrossWire SWORD module RusSynodal (zText,
 * OSIS markup, Synodal versification, with the deuterocanonical books) →
 * data/translations/ru-synodal.json.gz.
 *
 * Sources (public domain):
 *   mkdir -p private/sources/crosswire-russynodal private/sources/sword-canon
 *   curl -L -o private/sources/crosswire-russynodal/RusSynodal.zip https://www.crosswire.org/ftpmirror/pub/sword/packages/rawzip/RusSynodal.zip
 *   unzip -o private/sources/crosswire-russynodal/RusSynodal.zip -d private/sources/crosswire-russynodal/x
 *   curl -L -o private/sources/sword-canon/canon_synodal.h https://crosswire.org/svn/sword/trunk/include/canon_synodal.h
 * Run:
 *   node tools/translations/build-synodal.mjs
 *
 * The module's verse index follows SWORD's Synodal versification, so the
 * canon header gives the books and verse counts needed to read it.
 *
 * Text: <transChange type="added"> (the Synodal's italics) → [ … ]; the
 * Synodal's own square brackets (Septuagint additions) stay [ … ] as printed;
 * Psalm titles that are not verses of their own open verse 1; other headings
 * dropped. The Prayer of Manasseh, a book of its own in the module, becomes
 * 2 Chronicles 36:24–35, where the Synodal prints it. Brackets around a whole
 * noncanonical insertion are dropped (the insertion is marked as a range);
 * a bracket that runs past the end of a verse is closed and reopened, so each
 * verse is balanced. Not kept: the prologue of Sirach (the module's book
 * introduction; the format has no place for it).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from '../load.mjs';
import { bookMeta, books, clip, counts, dataDir, sourcesDir, writeTranslation } from './common.mjs';
import { balanceChapter, flattenBrackets, normalizeSpace } from './usfm.mjs';
import { parseCanonHeader, readZText } from './sword.mjs';
import { validateTranslation } from './validate.mjs';

const { SYNODAL_NONCANONICAL } = await load('core/versification/synodal');

const moduleDir = process.argv[2] ?? join(sourcesDir, 'crosswire-russynodal', 'x', 'modules', 'texts', 'ztext', 'russynodal');
const canonFile = process.argv[3] ?? join(sourcesDir, 'sword-canon', 'canon_synodal.h');

const OSIS = {
  Gen: 'GEN', Exod: 'EXO', Lev: 'LEV', Num: 'NUM', Deut: 'DEU', Josh: 'JOS', Judg: 'JDG', Ruth: 'RUT',
  '1Sam': '1SA', '2Sam': '2SA', '1Kgs': '1KI', '2Kgs': '2KI', '1Chr': '1CH', '2Chr': '2CH', PrMan: 'MAN',
  Ezra: 'EZR', Neh: 'NEH', '1Esd': '1ES', Tob: 'TOB', Jdt: 'JDT', Esth: 'EST', Job: 'JOB', Ps: 'PSA',
  Prov: 'PRO', Eccl: 'ECC', Song: 'SNG', Wis: 'WIS', Sir: 'SIR', Isa: 'ISA', Jer: 'JER', Lam: 'LAM',
  EpJer: 'LJE', Bar: 'BAR', Ezek: 'EZK', Dan: 'DAN', Hos: 'HOS', Joel: 'JOL', Amos: 'AMO', Obad: 'OBA',
  Jonah: 'JON', Mic: 'MIC', Nah: 'NAM', Hab: 'HAB', Zeph: 'ZEP', Hag: 'HAG', Zech: 'ZEC', Mal: 'MAL',
  '1Macc': '1MA', '2Macc': '2MA', '3Macc': '3MA', '2Esd': '2ES',
  Matt: 'MAT', Mark: 'MRK', Luke: 'LUK', John: 'JHN', Acts: 'ACT', Jas: 'JAS', '1Pet': '1PE', '2Pet': '2PE',
  '1John': '1JN', '2John': '2JN', '3John': '3JN', Jude: 'JUD', Rom: 'ROM', '1Cor': '1CO', '2Cor': '2CO',
  Gal: 'GAL', Eph: 'EPH', Phil: 'PHP', Col: 'COL', '1Thess': '1TH', '2Thess': '2TH', '1Tim': '1TI',
  '2Tim': '2TI', Titus: 'TIT', Phlm: 'PHM', Heb: 'HEB', Rev: 'REV',
};

/** The heading the module gives the Prayer of Manasseh (in capitals there). */
const MANASSEH_TITLE = 'Молитва Манассии, царя Иудейского, когда он содержался в плену в Вавилоне.';

/** A title run into the verse text needs its full stop. */
const endSentence = (s) => (/[.!?:;\]]$/.test(s) ? s : `${s}.`);

const upperFirst = (s) => s.replace(/^(\[?)(\p{Ll})/u, (_, b, ch) => b + ch.toUpperCase());

/** OSIS of one verse (or a chapter introduction) → plain text with [ … ]. */
function osisToText(osis) {
  let s = osis
    // A few notes and a heading sit in the text as escaped markup (Job 2:9,
    // 9:9, Ps 143:15): unescape them so the rules below drop them.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<note\b[^>]*>[\s\S]*?<\/note>/g, '')
    // Psalm titles belong to the text; other headings do not.
    .replace(/<title\b[^>]*canonical="true"[^>]*>([\s\S]*?)<\/title>/g, (_, t) => ` ${endSentence(upperFirst(t.trim()))} `)
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/g, ' ')
    .replace(/<transChange\b[^>]*>/g, '[')
    .replace(/<\/transChange>/g, ']')
    .replace(/<milestone\b[^>]*\/>/g, ' ')
    .replace(/<(lg|l|div|p|chapter|lb)\b[^>]*\/?>|<\/(lg|l|div|p)>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  s = flattenBrackets(s);
  return normalizeSpace(s);
}

const canon = parseCanonHeader(readFileSync(canonFile, 'utf8'), 'synodal');
const sword = new Map([...readZText(moduleDir, 'ot', canon.ot), ...readZText(moduleDir, 'nt', canon.nt)]);

const report = { droppedIntros: [], trimmed: [], spanning: [], stray: [], unwrapped: [] };

const raw = new Map(); // USFM id → string[][]
for (const { osis } of [...canon.ot, ...canon.nt]) {
  const id = OSIS[osis];
  if (!id) throw new Error(`no USFM id for ${osis}`);
  const book = sword.get(osis);
  if (osisToText(book.intro)) report.droppedIntros.push(`${id} (${osisToText(book.intro).length} chars)`);
  const chapters = book.chapters.map((chapter, c) => {
    const verses = chapter.verses.map(osisToText);
    const intro = osisToText(chapter.intro);
    if (intro) {
      // Only Psalm titles sit before the first verse; they open verse 1.
      if (id !== 'PSA') throw new Error(`${id} ${c + 1}: text before verse 1: ${clip(intro)}`);
      verses[0] = `${endSentence(upperFirst(intro))} ${verses[0]}`;
    }
    // The index keeps a slot for a verse the text does not have (Ps 114:9).
    while (verses.length && verses[verses.length - 1] === '') {
      verses.pop();
      report.trimmed.push(`${id} ${c + 1}:${verses.length + 1}`);
    }
    return verses;
  });
  raw.set(id, chapters);
}

// Psalm titles the module lost or invented, found by comparing it with the
// eBible.org Synodal (russyn): [psalm, title to put before verse 1, or '' to
// drop the module's]. Psalm 1 has no title in the Synodal (nor in the Hebrew
// or the Septuagint).
const PSALM_TITLE_FIXES = [
  [1, '', 'Псалом Давида. '],
  [31, 'Псалом Давида. Учение. ', ''],
  [108, 'Начальнику хора. ', 'Псалом Давида. '],
  [134, 'Аллилуия. ', ''],
];
for (const [psalm, add, expect] of PSALM_TITLE_FIXES) {
  const verses = raw.get('PSA')[psalm - 1];
  if (!verses[0].startsWith(expect)) throw new Error(`Ps ${psalm}:1 does not start with "${expect}"`);
  verses[0] = add + (add && expect ? verses[0] : verses[0].slice(expect.length));
}

// The Prayer of Manasseh closes 2 Chronicles.
const manasseh = raw.get('MAN');
raw.delete('MAN');
if (manasseh.length !== 1) throw new Error('Prayer of Manasseh: expected one chapter');
const chr36 = raw.get('2CH')[35];
if (chr36.length !== 23) throw new Error(`2 Chronicles 36: ${chr36.length} verses, expected 23`);
manasseh[0][0] = `${MANASSEH_TITLE} ${manasseh[0][0]}`;
chr36.push(...manasseh[0]);

// Brackets: unwrap whole insertions, then balance verse by verse.
function balanced(text) {
  let depth = 0;
  for (const ch of text) {
    depth += ch === '[' ? 1 : ch === ']' ? -1 : 0;
    if (depth < 0) return false;
  }
  return depth === 0;
}

for (const [id, ranges] of Object.entries(SYNODAL_NONCANONICAL)) {
  const chapters = raw.get(id);
  for (const range of ranges) {
    const [c1, v1, c2, v2] = range.split(/[.-]/).map(Number);
    const first = chapters[c1 - 1];
    const last = chapters[c2 - 1];
    const joined = [];
    for (let c = c1; c <= c2; c += 1) {
      const to = c === c2 ? v2 : chapters[c - 1].length;
      for (let v = c === c1 ? v1 : 1; v <= to; v += 1) joined.push(chapters[c - 1][v - 1]);
    }
    const text = joined.join(' ');
    const open = text.indexOf('[');
    if (!text.endsWith(']')) continue;
    if (open < 0 || open === text.length - 1) {
      // Only the closing bracket made it into the module (Ps 151).
      if (!balanced(text.slice(0, -1))) continue;
      last[v2 - 1] = normalizeSpace(last[v2 - 1].slice(0, -1));
      report.unwrapped.push(`${id} ${range} (closing bracket only)`);
      continue;
    }
    if (!balanced(text.slice(open + 1, -1))) continue;
    const at = first[v1 - 1].indexOf('[');
    first[v1 - 1] = normalizeSpace(first[v1 - 1].slice(0, at) + first[v1 - 1].slice(at + 1));
    last[v2 - 1] = normalizeSpace(last[v2 - 1].slice(0, -1));
    report.unwrapped.push(`${id} ${range}`);
  }
}

for (const [id, chapters] of raw) {
  chapters.forEach((verses, c) => {
    const { spanning, stray, unopened } = balanceChapter(verses);
    if (unopened.length) throw new Error(`${id} ${c + 1}:${unopened[0]}: closing bracket without an opening one`);
    report.spanning.push(...spanning.map((v) => `${id} ${c + 1}:${v}`));
    report.stray.push(...stray.map((v) => `${id} ${c + 1}:${v}`));
  });
}

const out = [];
for (const [id, chapters] of raw) {
  const canonical = books.isCanonicalBook(id);
  const entry = { id, ...bookMeta(id, 'ru') };
  if (!canonical) entry.canonical = false;
  if (SYNODAL_NONCANONICAL[id]) entry.noncanonical = [...SYNODAL_NONCANONICAL[id]];
  entry.chapters = chapters;
  out.push(entry);
}

const translation = {
  format: 'html-bible/translation',
  formatVersion: 1,
  id: 'ru-synodal',
  linkName: 'Synodal',
  version: '1.0.0',
  lang: 'ru',
  name: 'Синодальный перевод',
  shortName: 'SYN',
  year: 1876,
  license: 'Public domain',
  source:
    'https://www.crosswire.org/sword/modules/ModInfo.jsp?modName=RusSynodal (CrossWire SWORD module RusSynodal 1.9.1, text from patriarchia.ru; all 77 books including the deuterocanonical ones)',
  versification: 'synodal',
  books: out,
};

const errors = validateTranslation(translation);
const c = counts(translation);
const canonicalBooks = out.filter((b) => b.canonical !== false);
const sum = (list) => list.reduce((n, b) => n + b.chapters.reduce((m, ch) => m + ch.length, 0), 0);
console.log(
  `Synodal: ${c.books} books (${canonicalBooks.length} canonical), ${c.chapters} chapters, ${c.verses} verses ` +
    `(${sum(canonicalBooks)} in canonical books, ${sum(out.filter((b) => b.canonical === false))} in the others)`,
);
console.log(`  dropped introductions: ${report.droppedIntros.join(', ') || '—'}`);
console.log(`  trimmed empty verse slots: ${report.trimmed.join(', ') || '—'}`);
console.log(`  unwrapped insertions: ${report.unwrapped.join(', ') || '—'}`);
console.log(`  brackets across verses (closed and reopened): ${report.spanning.join(', ') || '—'}`);
console.log(`  stray brackets removed: ${report.stray.join(', ') || '—'}`);
if (c.books !== 77 || canonicalBooks.length !== 66) errors.push('expected 66 canonical + 11 other books');
if (errors.length) {
  for (const e of errors.slice(0, 30)) console.log(`  ${e}`);
  process.exit(1);
}
writeTranslation(join(dataDir, 'translations', 'ru-synodal.json.gz'), translation);
for (const [id, cc, vv] of [['GEN', 1, 1], ['PSA', 22, 1], ['2CH', 36, 24]]) console.log(`  ${id} ${cc}:${vv} ${clip(raw.get(id)[cc - 1][vv - 1])}`);
