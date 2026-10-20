/**
 * The SBL Greek New Testament (2010, v1.2 of 2023), a critical text made from
 * the oldest papyri and codices, in KJV versification →
 * data/translations/grc-sblgnt.json.gz. It is the Greek the AI evaluator reads
 * (server/src/originals.rs): of the editions here it stands nearest to the
 * oldest manuscripts.
 *
 * Source (CC BY 4.0, Society of Biblical Literature and Logos Bible Software):
 * the editors' repository, pinned to one commit:
 *   mkdir -p private/sources/sblgnt
 *   curl -L -o private/sources/sblgnt/sblgnt.zip https://codeload.github.com/LogosBible/SBLGNT/zip/c4d241a9c1c479a55b989ba35a4976c1d0b8052c
 *   (cd private/sources/sblgnt && unzip -o sblgnt.zip && mv SBLGNT-c4d241a* SBLGNT-master)
 * Run:
 *   node tools/translations/build-sblgnt.mjs
 *
 * New Testament only. The edition leaves out the verses the oldest witnesses
 * do not have (Matt 17:21, John 5:4, Acts 8:37, …, and the doxology of Romans,
 * 16:25–27): they stay empty. Four places are divided otherwise than in the
 * KJV and are folded into its numbering: Acts 19:40 (its last sentence is the
 * KJV's 19:41), 2 Cor 13:12–13 (the KJV's 12–14), 3 John 15 (the end of the
 * KJV's 14), Rev 12:18 (the start of the KJV's 13:1). Any other difference
 * from the KJV's shape fails the conversion.
 *
 * Text: the apparatus signs (⸀ ⸁ ⸂ ⸃ ⸄ ⸅, pointers into notes that are not
 * here) dropped; the editors' [ ] (words of doubtful originality) and ⟦ ⟧
 * (passages they judge later, Mark 16:9–20, John 7:53–8:11) kept, as the
 * edition prints them; NFC, spaces normalized.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from '../load.mjs';
import { clip, counts, dataDir, GREEK_NAMES, sourcesDir, writeTranslation } from './common.mjs';
import { normalizeSpace } from './usfm.mjs';
import { validateTranslation } from './validate.mjs';

const { KJV_COUNTS } = await load('core/versification/kjv-counts');

const dir = process.argv[2] ?? join(sourcesDir, 'sblgnt', 'SBLGNT-master', 'data', 'sblgnt', 'text');

/** id → the edition's name of the book (its file and the start of each line). */
const FILES = {
  MAT: 'Matt', MRK: 'Mark', LUK: 'Luke', JHN: 'John', ACT: 'Acts', ROM: 'Rom', '1CO': '1Cor', '2CO': '2Cor', GAL: 'Gal',
  EPH: 'Eph', PHP: 'Phil', COL: 'Col', '1TH': '1Thess', '2TH': '2Thess', '1TI': '1Tim', '2TI': '2Tim', TIT: 'Titus', PHM: 'Phlm',
  HEB: 'Heb', JAS: 'Jas', '1PE': '1Pet', '2PE': '2Pet', '1JN': '1John', '2JN': '2John', '3JN': '3John', JUD: 'Jude', REV: 'Rev',
};
const EMPTY = [
  'MAT 17:21', 'MAT 18:11', 'MAT 23:14', 'MRK 7:16', 'MRK 9:44', 'MRK 9:46', 'MRK 11:26', 'MRK 15:28', 'LUK 17:36', 'LUK 23:17',
  'JHN 5:4', 'ACT 8:37', 'ACT 15:34', 'ACT 24:7', 'ACT 28:29', 'ROM 16:25', 'ROM 16:26', 'ROM 16:27',
];

const clean = (text) => normalizeSpace(text.normalize('NFC').replace(/[⸀-⸅]/g, ''));

/** Lines "Matt 1:1<TAB>text"; the first line, the book's Greek title, is not a verse. */
function readBook(id, name) {
  const lines = readFileSync(join(dir, `${name}.txt`), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const chapters = [];
  for (const line of lines.slice(1)) {
    const m = /^(\S+) (\d+):(\d+)\t(.*)$/.exec(line);
    if (!m || m[1] !== name) throw new Error(`${name}.txt: ${clip(line, 60)}`);
    const verses = (chapters[Number(m[2]) - 1] ??= []);
    if (verses[Number(m[3]) - 1] !== undefined) throw new Error(`${id} ${m[2]}:${m[3]} twice`);
    verses[Number(m[3]) - 1] = clean(m[4]);
  }
  return chapters;
}

const errors = [];
const out = Object.entries(FILES).map(([id, name]) => {
  const [title, short] = GREEK_NAMES[id];
  return { id, name: title, short, chapters: readBook(id, name) };
});
const chaptersOf = (id) => out.find((b) => b.id === id).chapters;

/** Cut `chapters[c][v]` before `at`: the head stays, the tail is returned. */
function cut(id, c, v, at) {
  const verses = chaptersOf(id)[c - 1];
  const i = verses[v - 1].indexOf(at);
  if (i <= 0) {
    errors.push(`${id} ${c}:${v}: "${at}" not found`);
    return '';
  }
  const tail = verses[v - 1].slice(i).trim();
  verses[v - 1] = verses[v - 1].slice(0, i).trim();
  return tail;
}

// The doubtful words of Luke 22:19b–20 are one bracket over two verses: closed and reopened, so each verse balances.
const luke = chaptersOf('LUK')[21];
if (!/\[[^\]]*$/.test(luke[18]) || !/^[^[]*\]/.test(luke[19])) errors.push('LUK 22:19–20: the bracket is not where expected');
else [luke[18], luke[19]] = [`${luke[18]}]`, `[${luke[19]}`];
// Acts 19:40b → 19:41.
const acts = chaptersOf('ACT')[18];
if (acts.length !== 40) errors.push(`ACT 19: ${acts.length} verses, expected 40`);
else acts.push(cut('ACT', 19, 40, 'καὶ ταῦτα εἰπὼν'));
// 2 Cor 13:12b → 13:13, 13:13 → 13:14.
const cor = chaptersOf('2CO')[12];
if (cor.length !== 13) errors.push(`2CO 13: ${cor.length} verses, expected 13`);
else cor.splice(12, 0, cut('2CO', 13, 12, 'ἀσπάζονται ὑμᾶς'));
// 3 John 15 → the end of 14.
const john3 = chaptersOf('3JN')[0];
if (john3.length !== 15) errors.push(`3JN 1: ${john3.length} verses, expected 15`);
else john3[13] = `${john3[13]} ${john3.pop()}`;
// Rev 12:18 → the start of 13:1.
const rev = chaptersOf('REV');
if (rev[11].length !== 18) errors.push(`REV 12: ${rev[11].length} verses, expected 18`);
else rev[12][0] = `${rev[11].pop()} ${rev[12][0]}`;

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
  id: 'grc-sblgnt',
  linkName: 'SBLGNT',
  version: '1.2.0',
  lang: 'grc',
  name: 'Ἡ Καινὴ Διαθήκη — SBL Greek New Testament',
  shortName: 'SBLGNT',
  year: 2010,
  license: 'CC BY 4.0',
  source:
    'https://github.com/LogosBible/SBLGNT (commit c4d241a, data/sblgnt/text; The SBL Greek New Testament, Michael W. Holmes, ed., © 2010 Society of Biblical Literature and Logos Bible Software, CC BY 4.0)',
  versification: 'kjv',
  books: out,
};
errors.push(...validateTranslation(translation));

const c = counts(translation);
console.log(`SBLGNT: ${c.books} books, ${c.chapters} chapters, ${c.verses} verses, empty: ${empty.length}`);
if (errors.length) {
  for (const e of errors.slice(0, 30)) console.log(`  ${e}`);
  process.exit(1);
}
writeTranslation(join(dataDir, 'translations', `${translation.id}.json.gz`), translation);
for (const [id, cc, vv] of [['JHN', 3, 16], ['ACT', 19, 41], ['REV', 13, 1]]) console.log(`  ${id} ${cc}:${vv} ${clip(chaptersOf(id)[cc - 1][vv - 1])}`);
