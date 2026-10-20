/**
 * The Hebrew Old Testament, the Masoretic text (Westminster Leningrad Codex,
 * with vowels and accents), in KJV versification → data/translations/hbo-wlc.json.gz.
 *
 * Source (public domain):
 *   mkdir -p private/sources/ebible-hbo
 *   curl -L -o private/sources/ebible-hbo/hbo_usfm.zip https://ebible.org/Scriptures/hbo_usfm.zip
 *   unzip -o private/sources/ebible-hbo/hbo_usfm.zip -d private/sources/ebible-hbo/x
 * and the Paratext versification private/sources/ubsicap-vrs/eng.vrs.
 * eBible.org's hboWLC is the same text with Strong's numbers, some of them
 * left broken in the words, and without the ketiv/qere, so it is not the one
 * converted.
 * Run:
 *   node tools/translations/build-hebrew.mjs
 *
 * Old Testament only. The Hebrew numbering differs from the English in about
 * a hundred places: a Psalm title is a verse (or two) of its own, chapters
 * begin elsewhere (Joel 3 → 4, Malachi 4 → 3:19…). eng.vrs maps every such
 * Hebrew verse to the English one; a title (English verse 0) opens verse 1,
 * as in the KJV file, and two Hebrew verses on one English verse are joined.
 * eng.vrs cannot say where the English divides one Hebrew verse, so the
 * three such places are below (SPLITS, MOVES); Nehemiah 7:68 of the KJV
 * (horses and mules, from Ezra 2:66) is not in the Masoretic text and stays
 * empty. Every chapter must then have exactly the KJV's verses.
 *
 * Text as the source has it, ketiv and qere both: *written (read), the
 * edition's own mark. The one ASCII colon for sof pasuq becomes ׃.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from '../load.mjs';
import { books, clip, counts, dataDir, sourcesDir, writeTranslation } from './common.mjs';
import { normalizeSpace, readUsfmDir } from './usfm.mjs';
import { validateTranslation } from './validate.mjs';

const { KJV_COUNTS } = await load('core/versification/kjv-counts');

const dir = process.argv[2] ?? join(sourcesDir, 'ebible-hbo', 'x');
const vrsFile = process.argv[3] ?? join(sourcesDir, 'ubsicap-vrs', 'eng.vrs');

/** id → [name, short]: the Hebrew names, shortened as Hebrew citations do. */
const NAMES = {
  GEN: ['בראשית', 'בר׳'], EXO: ['שמות', 'שמ׳'], LEV: ['ויקרא', 'ויק׳'], NUM: ['במדבר', 'במ׳'], DEU: ['דברים', 'דב׳'],
  JOS: ['יהושע', 'יהו׳'], JDG: ['שופטים', 'שופ׳'], RUT: ['רות', 'רות'], '1SA': ['שמואל א', 'שמ״א'], '2SA': ['שמואל ב', 'שמ״ב'],
  '1KI': ['מלכים א', 'מל״א'], '2KI': ['מלכים ב', 'מל״ב'], '1CH': ['דברי הימים א', 'דה״א'], '2CH': ['דברי הימים ב', 'דה״ב'],
  EZR: ['עזרא', 'עז׳'], NEH: ['נחמיה', 'נחמ׳'], EST: ['אסתר', 'אס׳'], JOB: ['איוב', 'איוב'], PSA: ['תהלים', 'תה׳'],
  PRO: ['משלי', 'מש׳'], ECC: ['קהלת', 'קה׳'], SNG: ['שיר השירים', 'שה״ש'], ISA: ['ישעיהו', 'יש׳'], JER: ['ירמיהו', 'יר׳'],
  LAM: ['איכה', 'איכה'], EZK: ['יחזקאל', 'יח׳'], DAN: ['דניאל', 'דנ׳'], HOS: ['הושע', 'הו׳'], JOL: ['יואל', 'יואל'],
  AMO: ['עמוס', 'עמ׳'], OBA: ['עובדיה', 'עוב׳'], JON: ['יונה', 'יונה'], MIC: ['מיכה', 'מי׳'], NAM: ['נחום', 'נחום'],
  HAB: ['חבקוק', 'חב׳'], ZEP: ['צפניה', 'צפ׳'], HAG: ['חגי', 'חגי'], ZEC: ['זכריה', 'זכ׳'], MAL: ['מלאכי', 'מלאכי'],
};

/** Hebrew verses the English divides: the part from these words on is the next English verse. */
// אָשִׁ֥ירָה with its marks in the source's order (the shin dot before the hiriq).
const SPLITS = { 'PSA 13:6': '\u05d0\u05b8\u05e9\u05c1\u05b4\u05a5\u05d9\u05e8\u05b8\u05d4', 'ISA 63:19': 'לוּא־קָרַ֤עְת' };
/** Hebrew verses that open an English one of the next chapter: "And it came to pass after the plague" (Num 26:1). */
const MOVES = { 'NUM 25:19': [26, 1] };
const EMPTY = ['NEH 7:68'];

/** Hebrew verse → English verse, from eng.vrs lines like "PSA 3:0-8 = PSA 3:1-9" (English on the left). */
const vrs = new Map();
for (const line of readFileSync(vrsFile, 'utf8').split('\n')) {
  const m = /^([1-3A-Z]{3}) (\d+):(\d+)(?:-(\d+))? = \1 (\d+):(\d+)(?:-(\d+))?\s*$/.exec(line);
  if (!m) continue;
  const [, id, ec, ev1, ev2 = ev1, hc, hv1, hv2 = hv1] = m;
  if (ev2 - ev1 !== hv2 - hv1) throw new Error(`eng.vrs: ranges of different length: ${line}`);
  for (let i = 0; i <= ev2 - ev1; i += 1) vrs.set(`${id} ${hc}:${Number(hv1) + i}`, [Number(ec), Number(ev1) + i]);
}

const usfm = readUsfmDir(dir);
const errors = [];
const out = [];
let moved = 0;
for (const id of books.CANONICAL_BOOKS.slice(0, books.CANONICAL_BOOKS.indexOf('MAT'))) {
  const source = usfm.get(id);
  if (!source) throw new Error(`hbo has no ${id}`);
  const want = KJV_COUNTS[id];
  // English verse → its Hebrew pieces; a title (verse 0) goes before verse 1.
  const pieces = want.map((n) => Array.from({ length: n + 1 }, () => []));
  source.chapters.forEach((verses, c) =>
    verses.forEach((raw, v) => {
      const here = `${id} ${c + 1}:${v + 1}`;
      const mapped = MOVES[here] ?? vrs.get(here);
      const [ec, ev] = mapped ?? [c + 1, v + 1];
      if (mapped && (ec !== c + 1 || ev !== v + 1)) moved += 1;
      const put = (chapter, verse, text) => {
        const slot = pieces[chapter - 1]?.[verse];
        if (!slot) errors.push(`${here} → ${chapter}:${verse}: no such verse in the KJV`);
        else slot.push(text.replace(/:/g, '׃'));
      };
      const at = SPLITS[here] ? raw.indexOf(SPLITS[here]) : -1;
      if (SPLITS[here] && at <= 0) errors.push(`${here}: no "${SPLITS[here]}" to divide at`);
      if (at > 0) {
        put(ec, ev, raw.slice(0, at));
        // The next English verse: the following one, or verse 1 of the next chapter.
        if (ev < want[ec - 1]) put(ec, ev + 1, raw.slice(at));
        else put(ec + 1, 1, raw.slice(at));
      } else put(ec, ev, raw);
    }),
  );
  const chapters = pieces.map((chapter) => {
    const [title, ...verses] = chapter.map((p) => normalizeSpace(p.join(' ')));
    if (title) verses[0] = `${title} ${verses[0]}`;
    return verses;
  });
  const [name, short] = NAMES[id];
  out.push({ id, name, short, chapters });
}

const empty = out.flatMap((b) => b.chapters.flatMap((ch, c) => ch.flatMap((t, v) => (t ? [] : [`${b.id} ${c + 1}:${v + 1}`]))));
if (empty.join() !== EMPTY.join()) errors.push(`empty verses ${empty.slice(0, 10).join(', ')}, expected ${EMPTY.join(', ')}`);

const translation = {
  format: 'html-bible/translation',
  formatVersion: 1,
  id: 'hbo-wlc',
  linkName: 'WLC',
  version: '1.0.0',
  lang: 'hbo',
  name: 'תורה נביאים וכתובים — Westminster Leningrad Codex',
  shortName: 'WLC',
  license: 'Public domain',
  source: 'https://ebible.org/Scriptures/hbo_usfm.zip (eBible.org, The Old Testament in ancient Hebrew, following the Masoretic Text; public domain)',
  versification: 'kjv',
  books: out,
};
errors.push(...validateTranslation(translation));

const c = counts(translation);
console.log(`WLC: ${c.books} books, ${c.chapters} chapters, ${c.verses} verses; ${moved} Hebrew verses renumbered by eng.vrs`);
if (errors.length) {
  for (const e of errors.slice(0, 30)) console.log(`  ${e}`);
  process.exit(1);
}
writeTranslation(join(dataDir, 'translations', `${translation.id}.json.gz`), translation);
for (const [id, cc, vv] of [['GEN', 1, 1], ['PSA', 51, 1], ['ISA', 64, 1], ['NUM', 26, 1]]) console.log(`  ${id} ${cc}:${vv} ${clip(out.find((b) => b.id === id).chapters[cc - 1][vv - 1])}`);
