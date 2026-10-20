/**
 * The translation files in data/translations/: format, counts, the
 * noncanonical ranges against versification/synodal.ts, control verses, clean
 * text, the Synodal ⇄ KJV mapping checked against both texts, and the other
 * translations, each in the KJV's shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checker, load, needData, root } from '../tools/load.mjs';
import { textProblems, validateTranslation } from '../tools/translations/validate.mjs';

// The other translations: [id, verses left empty as the edition prints them, John 3:16].
const OTHERS = [
  ['en-asv', 16, 'For God so loved the world, that he gave his only begotten Son'],
  ['en-bsb', 16, 'For God so loved the world that He gave His one and only Son'],
  ['en-darby', 3, 'For God so loved the world, that he gave his only-begotten Son'],
  ['en-web', 4, 'For God so loved the world, that he gave his only born Son'],
  ['en-ylt', 0, 'for God did so love the world'],
  ['uk-ogienko', 0, 'Так бо Бог полюбив світ'],
];

needData('translations', 'translations/en-kjv.json.gz', 'translations/ru-synodal.json.gz', 'translations/grc-rp2018.json.gz', 'translations/grc-pt1904.json.gz', 'translations/grc-tr.json.gz', 'translations/grc-sblgnt.json.gz', 'translations/hbo-wlc.json.gz', ...OTHERS.map(([id]) => `translations/${id}.json.gz`));
const { check, done } = checker();
const { versification } = await load('core/versification/map');
const { KJV_COUNTS } = await load('core/versification/kjv-counts');
const { SYNODAL_NONCANONICAL } = await load('core/versification/synodal');
const { CANONICAL_BOOKS, EXTRA_BOOKS } = await load('core/books');

const read = (name) => {
  const raw = readFileSync(join(root, 'data', 'translations', name));
  check(`${name} is gzip`, [raw[0], raw[1]], [0x1f, 0x8b]);
  return JSON.parse(gunzipSync(raw).toString('utf8'));
};
const kjv = read('en-kjv.json.gz');
const syn = read('ru-synodal.json.gz');

const tally = (books) => ({
  books: books.length,
  chapters: books.reduce((n, b) => n + b.chapters.length, 0),
  verses: books.reduce((n, b) => n + b.chapters.reduce((m, c) => m + c.length, 0), 0),
});
const book = (t, id) => t.books.find((b) => b.id === id);
const verse = (t, id, c, v) => book(t, id)?.chapters[c - 1]?.[v - 1];

// Format
for (const [name, t] of [['KJV', kjv], ['Synodal', syn]]) {
  check(`${name}: validator`, validateTranslation(t), []);
  check(`${name}: format`, [t.format, t.formatVersion, t.license], ['html-bible/translation', 1, 'Public domain']);
}
check('KJV: header', [kjv.id, kjv.linkName, kjv.shortName, kjv.lang, kjv.versification], ['en-kjv', 'KJV', 'KJV', 'en', 'kjv']);
check('Synodal: header', [syn.id, syn.linkName, syn.shortName, syn.lang, syn.versification], ['ru-synodal', 'Synodal', 'SYN', 'ru', 'synodal']);

// Counts
check('KJV: counts', tally(kjv.books), { books: 66, chapters: 1189, verses: 31102 });
check('KJV: canonical order', kjv.books.map((b) => b.id), [...CANONICAL_BOOKS]);
check('KJV: counts match KJV_COUNTS', Object.fromEntries(kjv.books.map((b) => [b.id, b.chapters.map((c) => c.length)])), KJV_COUNTS);
check('kjv-counts.json matches KJV_COUNTS', JSON.parse(readFileSync(join(root, 'data', 'meta', 'kjv-counts.json'), 'utf8')), KJV_COUNTS);

const synCanonical = syn.books.filter((b) => b.canonical !== false);
const synExtra = syn.books.filter((b) => b.canonical === false);
check('Synodal: counts', tally(syn.books), { books: 77, chapters: 1361, verses: 37098 });
check('Synodal: canonical books', tally(synCanonical), { books: 66, chapters: 1192, verses: 31361 });
check('Synodal: deuterocanonical books', tally(synExtra), { books: 11, chapters: 169, verses: 5737 });
check('Synodal: deuterocanonical ids', synExtra.map((b) => b.id).sort(), [...EXTRA_BOOKS].sort());
check(
  'Synodal: deuterocanonical chapters/verses',
  Object.fromEntries(synExtra.map((b) => [b.id, `${b.chapters.length}/${b.chapters.reduce((n, c) => n + c.length, 0)}`])),
  { '1ES': '9/442', TOB: '14/244', JDT: '16/340', WIS: '19/440', SIR: '51/1523', LJE: '1/72', BAR: '5/141', '1MA': '16/924', '2MA': '15/556', '3MA': '7/180', '2ES': '16/875' },
);
check(
  'Synodal: book order',
  syn.books.map((b) => b.id).join(' '),
  'GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH 1ES TOB JDT EST JOB PSA PRO ECC SNG WIS SIR ISA JER LAM LJE BAR EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL 1MA 2MA 3MA 2ES ' +
    'MAT MRK LUK JHN ACT JAS 1PE 2PE 1JN 2JN 3JN JUD ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB REV',
);
check('Synodal: names from books.ts', [book(syn, 'GEN').name, book(syn, 'TOB').short, book(syn, '1ES').name], ['Бытие', 'Тов', '2 Ездры']);
check('KJV: names from books.ts', [book(kjv, 'GEN').name, book(kjv, 'SNG').short], ['Genesis', 'Song']);
check('Synodal: chapters of Psalms, Daniel, Joel, Malachi', [book(syn, 'PSA'), book(syn, 'DAN'), book(syn, 'JOL'), book(syn, 'MAL')].map((b) => b.chapters.length), [151, 14, 3, 4]);

// Noncanonical ranges
check(
  'Synodal: noncanonical ranges = synodal.ts',
  Object.fromEntries(syn.books.filter((b) => b.noncanonical).map((b) => [b.id, b.noncanonical])),
  SYNODAL_NONCANONICAL,
);
check('KJV: no noncanonical ranges', kjv.books.filter((b) => b.noncanonical || b.canonical === false).length, 0);

// Control verses
const S = versification('synodal');
const canon = (id, c, v) => S.toCanonical({ book: id, chapter: c, verse: v });
check('Gen 1:1 KJV', verse(kjv, 'GEN', 1, 1), 'In the beginning God created the heaven and the earth.');
check('Gen 1:1 Synodal', verse(syn, 'GEN', 1, 1), 'В начале сотворил Бог небо и землю.');
check('Synodal Ps 22:1 → KJV Ps 23:1', canon('PSA', 22, 1), { book: 'PSA', chapter: 23, verse: 1 });
check('Synodal Ps 22:1 text', /Господь - Пастырь мой/.test(verse(syn, 'PSA', 22, 1)), true);
check('KJV Ps 23:1 text', /The LORD \[is\] my shepherd/.test(verse(kjv, 'PSA', 23, 1)), true);
check('John 3:16 KJV', verse(kjv, 'JHN', 3, 16).startsWith('For God so loved the world'), true);
check('John 3:16 Synodal', verse(syn, 'JHN', 3, 16).startsWith('Ибо так возлюбил Бог мир'), true);
check('John 3:16 maps to itself', canon('JHN', 3, 16), { book: 'JHN', chapter: 3, verse: 16 });
// The Synodal keeps the KJV's chapter 4 of Malachi (Hebrew/LXX editions number it 3:19–24).
check('Synodal Mal 4:5 → KJV Mal 4:5', canon('MAL', 4, 5), { book: 'MAL', chapter: 4, verse: 5 });
check('Mal 4:5 Elijah in both', [/Илию/.test(verse(syn, 'MAL', 4, 5)), /Elijah/.test(verse(kjv, 'MAL', 4, 5))], [true, true]);
check('Synodal has no Mal 3:19', verse(syn, 'MAL', 3, 19), undefined);
check('Synodal Dan 3:91 → KJV Dan 3:24', canon('DAN', 3, 91), { book: 'DAN', chapter: 3, verse: 24 });
check('Dan 3:91 / 3:24 texts', [/^Навуходоносор/.test(verse(syn, 'DAN', 3, 91)), /Nebuchadnezzar/.test(verse(kjv, 'DAN', 3, 24))], [true, true]);
check('Tob 1:1 has no canonical key', canon('TOB', 1, 1), null);
check('Tob 1:1 text', verse(syn, 'TOB', 1, 1).startsWith('Книга сказаний Товита'), true);
check('Rev 22:21 KJV', verse(kjv, 'REV', 22, 21), 'The grace of our Lord Jesus Christ [be] with you all. Amen.');
check('Rev 22:21 Synodal', verse(syn, 'REV', 22, 21).startsWith('Благодать Господа нашего Иисуса Христа'), true);
check('Prayer of Manasseh closes 2 Chr 36', [book(syn, '2CH').chapters[35].length, verse(syn, '2CH', 36, 24).startsWith('Молитва Манассии')], [35, true]);
check('Psalm title opens verse 1 (KJV)', verse(kjv, 'PSA', 3, 1).startsWith('A Psalm of David, when he fled from Absalom his son. LORD'), true);
check('KJV italics as [ ]', verse(kjv, 'GEN', 1, 2).includes('[was]'), true);
check('Synodal italics as [ ]', verse(syn, 'EXO', 38, 30).includes('[для столбов]'), true);

// Clean text
for (const [name, t] of [['KJV', kjv], ['Synodal', syn]]) {
  const bad = [];
  let empty = 0;
  for (const b of t.books) {
    b.chapters.forEach((c, ci) =>
      c.forEach((text, vi) => {
        if (!text) empty += 1;
        else if (textProblems(text).length) bad.push(`${b.id} ${ci + 1}:${vi + 1} ${textProblems(text)}`);
      }),
    );
  }
  check(`${name}: no BOM, HTML, double spaces, unbalanced brackets`, bad.slice(0, 5), []);
  check(`${name}: no empty verses`, empty, 0);
}
const yo = syn.books.reduce((n, b) => n + b.chapters.reduce((m, c) => m + c.reduce((k, s) => k + (s.match(/ё/g) ?? []).length, 0), 0), 0);
check('Synodal: ё kept as in the source', yo > 50, true);

// The mapping against both texts: every Synodal verse of a canonical book is a
// listed insertion or maps to an existing KJV verse; every KJV verse comes
// from existing Synodal verses (Song 1:1, the Synodal's book title, aside).
const exists = (t, l) => typeof verse(t, l.book, l.chapter, l.verse) === 'string';
const problems = [];
for (const b of synCanonical) {
  b.chapters.forEach((c, ci) =>
    c.forEach((_, vi) => {
      const loc = { book: b.id, chapter: ci + 1, verse: vi + 1 };
      const all = S.toCanonicalAll(loc);
      if (S.isNoncanonical(loc)) {
        if (all.length) problems.push(`${b.id} ${ci + 1}:${vi + 1} noncanonical but mapped`);
      } else if (!all.length || !all.every((k) => exists(kjv, k))) problems.push(`${b.id} ${ci + 1}:${vi + 1} → ${JSON.stringify(all)}`);
    }),
  );
}
const missing = [];
for (const b of kjv.books) {
  b.chapters.forEach((c, ci) =>
    c.forEach((_, vi) => {
      const back = S.fromCanonical({ book: b.id, chapter: ci + 1, verse: vi + 1 });
      if (!back.length) missing.push(`${b.id} ${ci + 1}:${vi + 1}`);
      for (const n of back) if (!exists(syn, n) || S.isNoncanonical(n)) problems.push(`${b.id} ${ci + 1}:${vi + 1} ← ${JSON.stringify(n)}`);
    }),
  );
}
check('mapping fits both texts', problems.slice(0, 5), []);
check('KJV verses the Synodal lacks', missing, ['SNG 1:1']);

// The other translations: versification 'kjv' is identity, so each must have
// exactly the KJV's chapters and verses.
const others = Object.fromEntries(OTHERS.map(([id]) => [id, read(`${id}.json.gz`)]));
for (const [id, emptyVerses, john] of OTHERS) {
  const t = others[id];
  check(`${id}: validator`, validateTranslation(t), []);
  check(`${id}: header`, [t.id, t.lang, t.versification, t.license], [id, id.slice(0, 2), 'kjv', 'Public domain']);
  check(`${id}: canonical order`, t.books.map((b) => b.id), [...CANONICAL_BOOKS]);
  check(`${id}: the KJV's shape`, Object.fromEntries(t.books.map((b) => [b.id, b.chapters.map((c) => c.length)])), KJV_COUNTS);
  check(`${id}: empty verses`, t.books.reduce((n, b) => n + b.chapters.reduce((m, c) => m + c.filter((s) => !s).length, 0), 0), emptyVerses);
  check(`${id}: John 3:16`, verse(t, 'JHN', 3, 16).startsWith(john), true);
}
const greek = Object.fromEntries(['grc-rp2018', 'grc-pt1904', 'grc-tr'].map((id) => [id, read(`${id}.json.gz`)]));
const sbl = read('grc-sblgnt.json.gz');
const wlc = read('hbo-wlc.json.gz');
const linkNames = [kjv, syn, wlc, sbl, ...Object.values(greek), ...Object.values(others)].map((t) => t.linkName.toLowerCase());
check('link names differ', new Set(linkNames).size, linkNames.length);
check('WEB: the doxology of Romans moved to 16:25–27', [others['en-web'].books.find((b) => b.id === 'ROM').chapters[13].length, verse(others['en-web'], 'ROM', 16, 25).startsWith('Now to him who is able')], [23, true]);
check('Darby: no brackets around the doubtful John 5:3–4', /[[\]]/.test(verse(others['en-darby'], 'JHN', 5, 3) + verse(others['en-darby'], 'JHN', 5, 4)), false);
check('YLT: its added words as [ ]', verse(others['en-ylt'], 'PSA', 23, 1).includes('[is]'), true);
check('ASV: Selah without the stray bracket', verse(others['en-asv'], 'PSA', 3, 2).endsWith('Selah'), true);
const og = others['uk-ogienko'];
check('Ohienko: the title of Ps 51 opens verse 1', [verse(og, 'PSA', 51, 1).startsWith('Для дириґетна хору'), verse(og, 'PSA', 51, 1).includes('Помилуй мене, Боже')], [true, true]);
check('Ohienko: Ps 51:19 is the last verse', verse(og, 'PSA', 51, 19).length > 0 && verse(og, 'PSA', 51, 20) === undefined, true);
check('Ohienko: 1 Sam 21:1 closes 20:42', verse(og, '1SA', 20, 42).endsWith('а Йонатан пішов до міста.'), true);
check('Ohienko: 3 John 15 closes verse 14', [verse(og, '3JN', 1, 14).endsWith('Амінь.'), verse(og, '3JN', 1, 15)], [true, undefined]);
check('Ohienko: Ukrainian book names', [book(og, 'GEN').name, book(og, 'JHN').short], ['Буття', 'Ів']);

// The Greek New Testaments: the 27 books in the KJV's shape, nothing else.
// [id, verses left empty, John 3:16]
const NT = CANONICAL_BOOKS.slice(CANONICAL_BOOKS.indexOf('MAT'));
const GREEK_EMPTY = { 'grc-rp2018': ['LUK 17:36', 'ACT 8:37', 'ACT 15:34', 'ACT 24:7'], 'grc-pt1904': ['MRK 7:16'], 'grc-tr': [] };
for (const [id, empty] of Object.entries(GREEK_EMPTY)) {
  const t = greek[id];
  check(`${id}: validator`, validateTranslation(t), []);
  check(`${id}: header`, [t.id, t.lang, t.versification, t.license], [id, 'grc', 'kjv', 'Public domain']);
  check(`${id}: the New Testament in canonical order`, t.books.map((b) => b.id), NT);
  check(`${id}: the KJV's shape`, Object.fromEntries(t.books.map((b) => [b.id, b.chapters.map((c) => c.length)])), Object.fromEntries(NT.map((b) => [b, KJV_COUNTS[b]])));
  check(`${id}: empty verses`, t.books.flatMap((b) => b.chapters.flatMap((c, ci) => c.flatMap((s, vi) => (s ? [] : [`${b.id} ${ci + 1}:${vi + 1}`])))), empty);
  check(`${id}: John 3:16`, /^Οὕτως? γὰρ ἠγάπησεν ὁ [θΘ]εὸς τὸν κόσμον/i.test(verse(t, 'JHN', 3, 16)), true);
  check(`${id}: the doxology of Romans at 16:25–27`, [book(t, 'ROM').chapters[13].length, verse(t, 'ROM', 16, 25).startsWith('Τῷ δὲ δυναμένῳ')], [23, true]);
  check(`${id}: no paragraph marks, hyphens or brackets`, t.books.some((b) => b.chapters.some((c) => c.some((s) => /[¶\-[\]⟦⟧]/.test(s)))), false);
  check(`${id}: Greek book names`, [book(t, 'MAT').name, book(t, '1CO').short], ['Κατὰ Ματθαῖον', 'Α΄ Κορ']);
}
const pt = greek['grc-pt1904'];
check(`PT: John 1:38–39 of the edition is the KJV's 1:38`, [verse(pt, 'JHN', 1, 38).includes('ποῦ μένεις'), verse(pt, 'JHN', 1, 39).startsWith('λέγει αὐτοῖς· ἔρχεσθε')], [true, true]);
check(`PT: 2 Cor 13:12 of the edition divided at the KJV's 13:13`, [verse(pt, '2CO', 13, 12).endsWith('φιλήματι.'), verse(pt, '2CO', 13, 13)], [true, 'ἀσπάζονται ὑμᾶς οἱ ἅγιοι πάντες.']);
check('PT: 3 John 15 closes verse 14', verse(pt, '3JN', 1, 14).endsWith('κατ᾽ ὄνομα.'), true);
check('PT: Rev 15:9 closes verse 8', verse(pt, 'REV', 15, 8).endsWith('τῶν ἑπτὰ ἀγγέλων.'), true);
check('TR: no subscription after Romans', verse(greek['grc-tr'], 'ROM', 16, 27).includes('ἐγράφη'), false);

// The SBLGNT, the critical text the evaluator reads: the verses the oldest witnesses lack stay empty.
const SBL_EMPTY = ['MAT 17:21', 'MAT 18:11', 'MAT 23:14', 'MRK 7:16', 'MRK 9:44', 'MRK 9:46', 'MRK 11:26', 'MRK 15:28', 'LUK 17:36', 'LUK 23:17', 'JHN 5:4', 'ACT 8:37', 'ACT 15:34', 'ACT 24:7', 'ACT 28:29', 'ROM 16:25', 'ROM 16:26', 'ROM 16:27'];
check('SBLGNT: validator', validateTranslation(sbl), []);
check('SBLGNT: header', [sbl.id, sbl.lang, sbl.versification, sbl.license], ['grc-sblgnt', 'grc', 'kjv', 'CC BY 4.0']);
check('SBLGNT: the New Testament in canonical order', sbl.books.map((b) => b.id), NT);
check(`SBLGNT: the KJV's shape`, Object.fromEntries(sbl.books.map((b) => [b.id, b.chapters.map((c) => c.length)])), Object.fromEntries(NT.map((b) => [b, KJV_COUNTS[b]])));
check('SBLGNT: empty verses', sbl.books.flatMap((b) => b.chapters.flatMap((c, ci) => c.flatMap((s, vi) => (s ? [] : [`${b.id} ${ci + 1}:${vi + 1}`])))), SBL_EMPTY);
check('SBLGNT: John 1:1', verse(sbl, 'JHN', 1, 1), 'Ἐν ἀρχῇ ἦν ὁ λόγος, καὶ ὁ λόγος ἦν πρὸς τὸν θεόν, καὶ θεὸς ἦν ὁ λόγος.');
check('SBLGNT: no apparatus signs', sbl.books.some((b) => b.chapters.some((c) => c.some((s) => /[⸀-⸅]/.test(s)))), false);
check('SBLGNT: ⟦ ⟧ around the passages judged later', [verse(sbl, 'MRK', 16, 9).startsWith('⟦'), verse(sbl, 'JHN', 7, 53).startsWith('⟦')], [true, true]);
check(`SBLGNT: Acts 19:40b is the KJV's 19:41`, verse(sbl, 'ACT', 19, 41), 'καὶ ταῦτα εἰπὼν ἀπέλυσεν τὴν ἐκκλησίαν.');
check(`SBLGNT: 2 Cor 13:12 divided at the KJV's 13:13`, [verse(sbl, '2CO', 13, 13), verse(sbl, '2CO', 13, 14).startsWith('ἡ χάρις')], ['ἀσπάζονται ὑμᾶς οἱ ἅγιοι πάντες.', true]);
check('SBLGNT: 3 John 15 closes verse 14, Rev 12:18 opens 13:1', [verse(sbl, '3JN', 1, 14).endsWith('κατʼ ὄνομα.'), verse(sbl, 'REV', 13, 1).startsWith('καὶ ἐστάθη ἐπὶ τὴν ἄμμον')], [true, true]);
check('SBLGNT: Greek book names', [book(sbl, 'MAT').name, book(sbl, '1CO').short], ['Κατὰ Ματθαῖον', 'Α΄ Κορ']);

// The Hebrew Old Testament: the 39 books folded into the KJV's numbering.
const OT = CANONICAL_BOOKS.slice(0, CANONICAL_BOOKS.indexOf('MAT'));
// The source orders the marks of a letter its own way (never normalized: that breaks how they render), so compare normalized.
const opens = (text, start) => text.normalize('NFC').startsWith(start.normalize('NFC'));
check('WLC: validator', validateTranslation(wlc), []);
check('WLC: header', [wlc.id, wlc.lang, wlc.versification, wlc.license], ['hbo-wlc', 'hbo', 'kjv', 'Public domain']);
check('WLC: the Old Testament in canonical order', wlc.books.map((b) => b.id), OT);
check(`WLC: the KJV's shape`, Object.fromEntries(wlc.books.map((b) => [b.id, b.chapters.map((c) => c.length)])), Object.fromEntries(OT.map((b) => [b, KJV_COUNTS[b]])));
check('WLC: only Neh 7:68 empty (not in the Masoretic text)', wlc.books.flatMap((b) => b.chapters.flatMap((c, ci) => c.flatMap((s, vi) => (s ? [] : [`${b.id} ${ci + 1}:${vi + 1}`])))), ['NEH 7:68']);
check('WLC: Genesis 1:1', opens(verse(wlc, 'GEN', 1, 1), 'בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים'), true);
check('WLC: the title of Ps 51 opens verse 1, Ps 51:19 is the last', [opens(verse(wlc, 'PSA', 51, 1), 'לַמְנַצֵּ֗חַ'), verse(wlc, 'PSA', 51, 19).length > 0, verse(wlc, 'PSA', 51, 20)], [true, true, undefined]);
check('WLC: Malachi 3:19–24 of the Hebrew is the KJV\'s chapter 4', [book(wlc, 'MAL').chapters.length, book(wlc, 'MAL').chapters[3].length], [4, 6]);
check('WLC: Isa 63:19b is the KJV\'s 64:1', opens(verse(wlc, 'ISA', 64, 1), 'לוּא־קָרַ֤עְתָּ'), true);
check('WLC: Num 25:19 opens the KJV\'s 26:1', opens(verse(wlc, 'NUM', 26, 1), 'וַיְהִ֖י אַחֲרֵ֣י הַמַּגֵּפָ֑ה'), true);
check('WLC: Hebrew book names', [book(wlc, 'GEN').name, book(wlc, 'PSA').short], ['בראשית', 'תה׳']);

// A new reader is offered the first translation of their language.
const catalog = JSON.parse(readFileSync(join(root, 'data', 'catalog.json'), 'utf8'));
check('catalog: the KJV and the Synodal first', catalog.translations.slice(0, 2).map((t) => t.id), ['en-kjv', 'ru-synodal']);

done('translations');
