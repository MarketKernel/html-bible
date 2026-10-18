/**
 * Checks src/core/versification/synodal.ts against the converted texts and
 * against CrossWire's own Synodal → KJV mapping.
 *
 *   node tools/translations/verify-versification.mjs
 *
 * Needs data/translations/{en-kjv,ru-synodal}.json.gz (build-kjv.mjs,
 * build-synodal.mjs) and, for the CrossWire comparison,
 * private/sources/sword-canon/canon_synodal.h (see build-synodal.mjs).
 *
 * 1. Every Synodal verse of a canonical book maps to existing KJV verses, or
 *    is a listed insertion; every KJV verse has existing Synodal verses, or is
 *    listed as missing; native ⇄ canonical agree both ways.
 * 2. Differences from CrossWire's mappings_synodal, verse by verse, grouped
 *    by chapter: each one must be a known correction (listed below).
 * 3. Length check: a shifted mapping pairs verses of unrelated length, so the
 *    Russian/English length ratio of mapped verses is compared with the median
 *    and the worst outliers are printed for a look.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from '../load.mjs';
import { clip, dataDir, readTranslation, sourcesDir } from './common.mjs';
import { parseCanonHeader, parseCanonMappings } from './sword.mjs';

const { versification } = await load('core/versification/map');
const { KJV_COUNTS } = await load('core/versification/kjv-counts');
const syn = versification('synodal');

const kjv = readTranslation(join(dataDir, 'translations', 'en-kjv.json.gz'));
const ru = readTranslation(join(dataDir, 'translations', 'ru-synodal.json.gz'));
const ruBooks = new Map(ru.books.map((b) => [b.id, b]));
const kjvBooks = new Map(kjv.books.map((b) => [b.id, b]));
const ruText = (l) => ruBooks.get(l.book)?.chapters[l.chapter - 1]?.[l.verse - 1];
const kjvText = (l) => kjvBooks.get(l.book)?.chapters[l.chapter - 1]?.[l.verse - 1];
const fmt = (l) => `${l.book} ${l.chapter}:${l.verse}`;

const errors = [];
let natives = 0;
let insertions = 0;
for (const book of ru.books) {
  book.chapters.forEach((verses, c) => {
    verses.forEach((text, v) => {
      const loc = { book: book.id, chapter: c + 1, verse: v + 1 };
      const all = syn.toCanonicalAll(loc);
      if (syn.isNoncanonical(loc)) {
        insertions += 1;
        if (all.length || syn.toCanonical(loc) !== null) errors.push(`${fmt(loc)}: noncanonical but maps to ${all.map(fmt)}`);
        return;
      }
      natives += 1;
      if (!all.length) errors.push(`${fmt(loc)}: no canonical verse`);
      for (const k of all) {
        if (KJV_COUNTS[k.book]?.[k.chapter - 1] === undefined || k.verse > KJV_COUNTS[k.book][k.chapter - 1] || k.verse < 1) {
          errors.push(`${fmt(loc)} → ${fmt(k)}: no such KJV verse`);
        } else if (!syn.fromCanonical(k).some((n) => n.chapter === loc.chapter && n.verse === loc.verse)) {
          errors.push(`${fmt(loc)} → ${fmt(k)}, but back: ${syn.fromCanonical(k).map(fmt)}`);
        }
      }
    });
  });
}
let canon = 0;
let missing = 0;
let splits = 0;
for (const [book, list] of Object.entries(KJV_COUNTS)) {
  list.forEach((count, c) => {
    for (let v = 1; v <= count; v += 1) {
      canon += 1;
      const k = { book, chapter: c + 1, verse: v };
      const back = syn.fromCanonical(k);
      if (!back.length) {
        missing += 1;
        continue;
      }
      if (back.length > 1) splits += 1;
      for (const n of back) {
        if (!ruText(n)) errors.push(`${fmt(k)} ← ${fmt(n)}: no such Synodal verse`);
        if (!syn.toCanonicalAll(n).some((x) => x.chapter === k.chapter && x.verse === k.verse)) errors.push(`${fmt(k)} ← ${fmt(n)}: not back`);
      }
    }
  });
}
console.log(`Synodal canonical-book verses: ${natives} mapped, ${insertions} insertions/deuterocanonical; KJV verses: ${canon}, ${missing} missing in the Synodal, ${splits} held by several Synodal verses`);
console.log(errors.length ? `ERRORS: ${errors.length}\n  ${errors.slice(0, 30).join('\n  ')}` : 'coverage: OK');

// 2. CrossWire comparison.
const canonFile = join(sourcesDir, 'sword-canon', 'canon_synodal.h');
if (existsSync(canonFile)) {
  const src = readFileSync(canonFile, 'utf8');
  const header = parseCanonHeader(src, 'synodal');
  const books = [...header.ot, ...header.nt];
  const maps = parseCanonMappings(src, 'synodal');
  const osisToId = Object.fromEntries(ru.books.map((b) => [b.id, b.id]));
  const order = ['GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'MAN', 'EZR', 'NEH', '1ES', 'TOB', 'JDT', 'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'WIS', 'SIR', 'ISA', 'JER', 'LAM', 'LJE', 'BAR', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL', '1MA', '2MA', '3MA', '2ES', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'REV'];
  if (order.length !== books.length) throw new Error('CrossWire book list changed');
  const rules = new Map();
  const b = maps.bytes;
  for (let i = 0; b[i] !== 0; i += 7) {
    const m = b.slice(i, i + 8);
    const own = m[0] > books.length ? m[7] : m[0];
    if (m[0] > books.length) i += 1;
    if (!rules.has(own)) rules.set(own, []);
    rules.get(own).push(m);
  }
  // SWORD's forward translation (VersificationMgr::System::translateVerse).
  const sword = (bookIndex, c, v) => {
    const list = rules.get(bookIndex) ?? [];
    for (let k = list.length - 1; k >= 0; k -= 1) {
      const m = list[k];
      if (m[1] < c) break;
      if (m[1] === c && m[2] <= v) {
        if (m[0] > books.length) return [];
        if (m[2] === v || m[3] >= v) {
          const out = [];
          for (let x = m[5]; x <= Math.max(m[5], m[6]); x += 1) out.push(`${m[4]}:${x || 1}`);
          return [...new Set(out)];
        }
        return [`${m[4]}:${v - (Math.max(m[2], m[3]) - Math.max(m[5], m[6]))}`];
      }
    }
    return [`${c}:${v}`];
  };
  const groups = new Map();
  for (const book of ru.books) {
    if (book.canonical === false) continue;
    const index = order.indexOf(osisToId[book.id]) + 1;
    book.chapters.forEach((verses, c) => {
      verses.forEach((_, v) => {
        const loc = { book: book.id, chapter: c + 1, verse: v + 1 };
        const ours = syn.toCanonicalAll(loc).map((x) => `${x.chapter}:${x.verse}`).join(',') || '—';
        let theirs = book.id === '2CH' && c === 35 && v >= 23 ? [] : sword(index, c + 1, v + 1);
        // SWORD "maps" a verse past the KJV chapter end to itself: no verse.
        theirs = theirs.filter((t) => {
          const [tc, tv] = t.split(':').map(Number);
          return tv <= (KJV_COUNTS[book.id][tc - 1] ?? 0);
        });
        const t = theirs.join(',') || '—';
        if (ours !== t) {
          const g = `${book.id} ${c + 1}`;
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(`${v + 1}: ours ${ours}, SWORD ${t}`);
        }
      });
    });
  }
  console.log(`differences from CrossWire mappings_synodal: ${[...groups.values()].reduce((n, g) => n + g.length, 0)} verses in ${groups.size} chapters`);
  for (const [g, list] of groups) console.log(`  ${g} (${list.length}): ${list.slice(0, 2).join('; ')}${list.length > 2 ? ' …' : ''}`);
}

// 3. Length ratios of mapped verse groups.
const ratios = [];
for (const [book, list] of Object.entries(KJV_COUNTS)) {
  list.forEach((count, c) => {
    for (let v = 1; v <= count; v += 1) {
      const k = { book, chapter: c + 1, verse: v };
      const back = syn.fromCanonical(k);
      if (back.length !== 1) continue;
      const parts = syn.toCanonicalAll(back[0]);
      if (parts.length !== 1) continue;
      const r = ruText(back[0]).replace(/[[\]]/g, '').length / kjvText(k).replace(/[[\]]/g, '').length;
      ratios.push([r, k, back[0]]);
    }
  });
}
const sorted = ratios.map((x) => x[0]).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
// Runs of 3+ consecutive outliers would betray a shift; single ones are style.
let run = [];
const runs = [];
for (const item of ratios) {
  const off = Math.abs(Math.log(item[0] / median)) > Math.log(1.9);
  if (off && run.length && run[run.length - 1][1].book === item[1].book && run[run.length - 1][1].chapter === item[1].chapter) run.push(item);
  else {
    if (run.length >= 3) runs.push(run);
    run = off ? [item] : [];
  }
}
if (run.length >= 3) runs.push(run);
console.log(`length ratio ru/en: median ${median.toFixed(2)}; runs of 3+ outliers (ratio off by ×1.9): ${runs.length}`);
for (const r of runs.slice(0, 10)) console.log(`  ${fmt(r[0][1])}…${r[r.length - 1][1].verse}: ${r.map((x) => x[0].toFixed(2)).join(' ')} | ${clip(ruText(r[0][2]), 60)} | ${clip(kjvText(r[0][1]), 60)}`);
if (errors.length) process.exit(1);
