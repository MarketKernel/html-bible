/**
 * Routes, the Markdown subset (with XSS vectors), search, package checks
 * and the rating helpers — the DOM-free core.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const C = await load('core/route', 'core/markdown', 'core/search', 'core/pack', 'core/discussion-file', 'core/time', 'core/rating');

/* ---------------- routes ---------------- */
const route = (hash) => C.parseRoute(hash);
check('route: empty', route(''), { name: 'home' });
check('route: verse', route('#Synodal_Mat3-3'), { name: 'read', ref: { linkName: 'Synodal', book: 'MAT', parts: [{ chapter: 3, verse: 3 }] } });
check('route: options', route('#Synodal_Mat3-3?notes=0&par=KJV&c=01ABC'), {
  name: 'read', ref: { linkName: 'Synodal', book: 'MAT', parts: [{ chapter: 3, verse: 3 }] }, notes: false, par: 'KJV', comment: '01ABC',
});
check('route: free form encoded', route('#%D0%9C%D1%84%202:3'), { name: 'read', ref: { book: 'MAT', parts: [{ chapter: 2, verse: 3 }] } });
check('route: free form raw', route('#Мф 2:3'), { name: 'read', ref: { book: 'MAT', parts: [{ chapter: 2, verse: 3 }] } });
check('route: compare', route('#/compare/Mat3-16-18'), { name: 'compare', ref: { book: 'MAT', parts: [{ chapter: 3, verse: 16, endVerse: 18 }] } });
check('route: search', route('#/search?q=%D0%BB%D1%8E%D0%B1%D0%BE%D0%B2%D1%8C&in=NT'), { name: 'search', q: 'любовь', scope: 'NT' });
check('route: search with a chosen hit', route('#/search?q=x&at=HEB.1.3'), { name: 'search', q: 'x', at: 'HEB.1.3' });
check('route: search, bad hit ignored', route('#/search?q=x&at=<b>'), { name: 'search', q: 'x' });
check('route: discussions', route('#/discussions'), { name: 'discussions' });
check('route: discussion', route('#/discussions/q1'), { name: 'discussion', id: 'q1' });
check('route: argument', route('#/discussions/q1/a/a2'), { name: 'discussion', id: 'q1', argument: 'a2' });
check('route: verse of a subtopic', route('#/discussions/q1/v/v3'), { name: 'discussion', id: 'q1', verse: 'v3' });
check('route: unknown', route('#/nothing').name, 'unknown');
check('route: bad option ignored', route('#Mat3-3?notes=yes&par=<x>'), { name: 'read', ref: { book: 'MAT', parts: [{ chapter: 3, verse: 3 }] } });
for (const hash of ['#/search?q=x&in=NT&at=HEB.1.3', '#Synodal_Mat3-3', '#Synodal_Mat3-3?notes=0&par=KJV', '#/compare/Mat3-16-18', '#/search?q=love&in=NT', '#/discussions', '#/discussions/q1/a/a2', '#/discussions/q1/v/v3']) {
  check(`route round trip ${hash}`, C.formatRoute(C.parseRoute(hash)), hash);
}
check('route: free form becomes readable', C.formatRoute(route('#Мф 2:3')), '#Mat2-3');

/* ---------------- markdown ---------------- */
const md = (text) => C.parseMarkdown(text);
check('md: bold italic', md('**a** *b* _c_'), [{ t: 'p', c: [{ t: 'b', c: [{ t: 'text', v: 'a' }] }, { t: 'text', v: ' ' }, { t: 'i', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' ' }, { t: 'i', c: [{ t: 'text', v: 'c' }] }] }]);
check('md: link', md('[site](https://example.com/a)'), [{ t: 'p', c: [{ t: 'a', href: 'https://example.com/a', insecure: false, c: [{ t: 'text', v: 'site' }] }] }]);
check('md: http link marked', md('[x](http://example.com)')[0].c[0].insecure, true);
check('md: image', md('![cat](https://example.com/c.png)'), [{ t: 'p', c: [{ t: 'img', src: 'https://example.com/c.png', alt: 'cat' }] }]);
check('md: paragraphs and break', md('a\nb\n\nc'), [{ t: 'p', c: [{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b' }] }, { t: 'p', c: [{ t: 'text', v: 'c' }] }]);
check('md: quote', md('> q'), [{ t: 'quote', c: [{ t: 'p', c: [{ t: 'text', v: 'q' }] }] }]);
check('md: list', md('- a\n- b'), [{ t: 'ul', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] }]);
check('md: verse ref', md('[[Mat3-3]]')[0].c[0].t, 'ref');
check('md: verse in text', md('см. Ин 3:16')[0].c.map((n) => n.t), ['text', 'ref']);
check('md: bare url', md('see https://example.com/x.')[0].c.map((n) => n.t), ['text', 'a', 'text']);
check('md: snake_case stays', md('snake_case_name'), [{ t: 'p', c: [{ t: 'text', v: 'snake_case_name' }] }]);
check('md: escape', md('\\*not\\*'), [{ t: 'p', c: [{ t: 'text', v: '*not*' }] }]);

// Nothing dangerous may come out of the tree: only https/http hrefs, only https images, no raw HTML nodes.
const XSS = [
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x]( javascript:alert(1))',
  '[x](data:text/html,<script>alert(1)</script>)',
  '![x](javascript:alert(1))',
  '![x](data:image/svg+xml,<svg onload=alert(1)>)',
  '![x](http://example.com/a.png)',
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '[x](vbscript:msgbox)',
  '[x](//evil.example)',
  '[x](/relative)',
  '[[x]](javascript:alert(1))',
  '[a[b](javascript:1)](https://ok.example)',
  '**[x](javascript:alert(1))**',
  'https://ok.example/"onmouseover="alert(1)',
  '[x](https://ok.example/\\"onclick=alert(1))',
];
const walk = (nodes, out) => {
  for (const node of nodes) {
    if (node.t === 'p') walk(node.c, out);
    else if (node.t === 'quote') walk(node.c, out);
    else if (node.t === 'ul') node.items.forEach((item) => walk(item, out));
    else if (node.t === 'a') {
      out.push(['a', node.href]);
      walk(node.c, out);
    } else if (node.t === 'img') out.push(['img', node.src]);
    else if (node.t === 'b' || node.t === 'i') walk(node.c, out);
  }
  return out;
};
for (const vector of XSS) {
  const bad = walk(md(vector), []).filter(([kind, url]) => (kind === 'a' ? !/^https?:\/\/[^/]/.test(url) : !/^https:\/\/[^/]/.test(url)) || /["<>\s]/.test(url));
  check(`xss: ${vector}`, bad, []);
}
check('xss: raw html stays text', md('<b>x</b>'), [{ t: 'p', c: [{ t: 'text', v: '<b>x</b>' }] }]);
check('md: image count', C.countImages(md('![a](https://e.x/1) ![b](https://e.x/2)\n> ![c](https://e.x/3)')), 3);
check('md: plain text', C.plainText(md('**Bold** and [link](https://e.x)\n- item')), 'Bold and link item');

/* ---------------- search ---------------- */
check('normalize', C.normalize('Ёлка, «Свет»! It’s'), 'елка свет its');
check('query', C.parseQuery('Бог "в начале" -тьма люб*'), { words: ['бог', 'люб'], phrases: ['в начале'], not: ['тьма'] });
const translation = {
  id: 't', books: [
    { id: 'GEN', canonical: true, chapters: [['В начале сотворил Бог небо и землю.', 'Земля же была безвидна и пуста, и тьма над бездною.']] },
    { id: 'JHN', chapters: [['В начале было Слово.'], [], ['Ибо так возлюбил Бог мир.']] },
    { id: 'HEB', chapters: [['Сей, будучи сияние славы и образ ипостаси Его.'], ['Убогий и Богатый.']] },
    { id: 'TOB', canonical: false, chapters: [['Книга слов Товита.']] },
  ],
};
const index = C.buildIndex(translation, () => false);
const find = (q, filter = { includeNoncanonical: true }) => C.search(index, C.parseQuery(q), filter).hits.map((h) => `${h.book}.${h.chapter}.${h.verse}`);
check('search: start of a word', find('Бог'), ['GEN.1.1', 'JHN.3.1', 'HEB.2.1']);
check('search: part of a word', find('ипоста'), ['HEB.1.1']);
check('search: exact word in quotes', find('"бог"'), ['GEN.1.1', 'JHN.3.1']);
check('search: not inside a word', find('бог -богат'), ['GEN.1.1', 'JHN.3.1']);
check('search: phrase', find('"в начале"'), ['GEN.1.1', 'JHN.1.1']);
check('search: not', find('"в начале" -бог'), ['JHN.1.1']);
check('search: trailing star', find('возлюб*'), ['JHN.3.1']);
check('search: the middle of a word is not a start', find('люб'), []);
check('search: testament', find('"в начале"', { includeNoncanonical: true, testament: 'NT' }), ['JHN.1.1']);
check('search: books', find('"в начале"', { includeNoncanonical: true, books: new Set(['GEN']) }), ['GEN.1.1']);
check('search: noncanonical included', find('книга'), ['TOB.1.1']);
check('search: noncanonical excluded', find('книга', { includeNoncanonical: false }), []);
check('search: ё', find('ТЬМА'), ['GEN.1.2']);
check('search: empty', find(''), []);
check('highlights', C.highlights('В начале сотворил Бог', C.parseQuery('бог')), [[18, 21]]);
check('highlights a part', C.highlights('образ ипостаси Его', C.parseQuery('ипоста')), [[6, 14]]);

/* ---------------- packs ---------------- */
const goodTranslation = {
  format: 'html-bible/translation', formatVersion: 1, id: 'x-test', linkName: 'Test', version: '1', lang: 'ru', name: 'T', shortName: 'T',
  license: 'PD', versification: 'kjv', books: [{ id: 'GEN', name: 'Бытие', short: 'Быт', chapters: [['a']] }],
};
const kind = (json) => {
  try {
    return C.identify(json).kind;
  } catch (error) {
    return error.message;
  }
};
check('pack: translation', kind(goodTranslation), 'translation');
check('pack: bad book', kind({ ...goodTranslation, books: [{ id: 'XXX', name: 'a', short: 'a', chapters: [['a']] }] }), 'Unknown book: XXX.');
check('pack: deuterocanon must be marked', kind({ ...goodTranslation, books: [{ id: 'TOB', name: 'a', short: 'a', chapters: [['a']] }] }), 'The book TOB must be marked noncanonical.');
check('pack: newer format', kind({ ...goodTranslation, formatVersion: 2 }), 'This file was made for a newer version of the app.');
check('pack: bad link name', kind({ ...goodTranslation, linkName: 'Has space' }), 'The translation’s link name must be Latin letters and digits.');
check('pack: not ours', kind({ hello: 1 }), 'The file is not a translation or a commentary.');
check('pack: broken chapter', kind({ ...goodTranslation, books: [{ id: 'GEN', name: 'a', short: 'a', chapters: [[1]] }] }), 'A chapter of GEN is broken.');
const commentary = { format: 'html-bible/commentary', formatVersion: 1, id: 'my-1', version: '1', lang: 'ru', name: 'Мои', entries: [{ id: 'c1', ref: 'JHN.3.16-JHN.3.18', md: 'x' }] };
check('pack: commentary', kind(commentary), 'commentary');
check('pack: noncanonical ref rejected', kind({ ...commentary, entries: [{ ref: 'TOB.1.1', md: 'x' }] }), 'A commentary entry has a bad reference: TOB.1.1.');
check('pack: backwards ref rejected', kind({ ...commentary, entries: [{ ref: 'JHN.3.18-JHN.3.16', md: 'x' }] }), 'A commentary entry has a bad reference: JHN.3.18-JHN.3.16.');
check('pack: manifest path traversal', kind({ ...commentary, entries: undefined, books: [{ id: 'GEN', url: '../x.json', bytes: 1, sha256: '', entries: 1 }] }), 'The commentary’s book list is broken.');
check('canonical ref', [C.isCanonicalRef('JHN.3.16'), C.isCanonicalRef('1CO.13.4-1CO.13.7'), C.isCanonicalRef('JHN.3.16-ROM.1.1'), C.isCanonicalRef('TOB.1.1')], [true, true, false, false]);

/* ---------------- profile routes ---------------- */
check('route: profile', [route('#/profile'), C.formatRoute({ name: 'profile' })], [{ name: 'profile' }, '#/profile']);
check('route: a member', route('#/users/2764d8bf-5142-5be3-b585-4991ff43a045'), { name: 'user', id: '2764d8bf-5142-5be3-b585-4991ff43a045' });
check('route: an invitation', [route('#/join/1-7-K3M9Q-T8ZR2'), C.formatRoute({ name: 'join', code: '1-7-K3M9Q-T8ZR2' })], [{ name: 'join', code: '1-7-K3M9Q-T8ZR2' }, '#/join/1-7-K3M9Q-T8ZR2']);
check('route: not an invitation', [route('#/join/'), route('#/join/<script>')].map((r) => r.name), ['unknown', 'unknown']);

/* ---------------- time ---------------- */
// Moscow is UTC+3 all year: 09:05 UTC is 12:05 there, and 22:30 UTC the day before is already today.
const nowUtc = new Date('2026-10-19T12:00:00Z');
const msk = (iso, lang = 'ru') => C.formatTime(iso, lang, nowUtc, 'Europe/Moscow');
check('time: today', [msk('2026-10-19T09:05:00Z'), msk('2026-10-18T22:30:00Z')], ['12:05', '01:30']);
check('time: this year', msk('2026-03-05T11:05:00Z'), '5 мар., 14:05');
check('time: earlier', msk('2025-03-05T11:05:00Z'), '5 мар. 2025 г., 14:05');
check('time: English', msk('2026-03-05T11:05:00Z', 'en'), 'Mar 5, 02:05 PM');
check('time: broken', msk('yesterday'), '');
check('time: full, with the zone', C.fullTime('2026-10-19T09:05:00Z', 'ru', 'Europe/Moscow'), '19 октября 2026 г. в 12:05 GMT+3');
check('day of the server: its midnight in the reader\'s zone', C.formatDay('2026-10-20', 'ru', 'Europe/Moscow'), '20 октября в 03:00');

/* ---------------- discussion file ---------------- */
const full = {
  question: { id: 'Q', title: { orig: 'en', en: 'Is it so?', ru: 'Так ли?' } },
  arguments: [{ id: 'A' }],
  verses: [{ id: 'V', votes: { pro: 2, con: 1, none: 0, mine: 1 } }],
  interpretations: [{ id: 'T', votes: { up: 1, down: 0, mine: null } }, { id: 'T2', votes: { up: 0, down: 0 } }],
};
const saved = C.discussionFile(full, 'https://api.example.org/v1/', new Date('2026-10-18T12:00:00Z'));
check('discussion file: header', [saved.format, saved.formatVersion, saved.exportedAt, saved.source], ['html-bible/discussion', 1, '2026-10-18T12:00:00.000Z', 'https://api.example.org/v1/']);
check('discussion file: no one\'s own votes', [saved.verses[0].votes, saved.interpretations[0].votes], [{ pro: 2, con: 1, none: 0 }, { up: 1, down: 0 }]);
check('discussion file: the rest as it was', [saved.question, saved.arguments, saved.interpretations[1]], [full.question, full.arguments, full.interpretations[1]]);
check('discussion file: the screen\'s data untouched', full.verses[0].votes.mine, 1);
const day = new Date('2026-10-18T12:00:00Z');
check('file name', [C.discussionFileName('Is the Trinity biblical?', day), C.discussionFileName('Соответствует ли учение о Троице Библии?', day), C.discussionFileName('!!!', day)], [
  'discussion-is-the-trinity-biblical-2026-10-18.json',
  'discussion-соответствует-ли-учение-о-троице-библии-2026-10-18.json',
  'discussion-2026-10-18.json',
]);

/* ---------------- rating ---------------- */
check('tilt', [C.tilt(50), C.tilt(-200), C.tilt(null)], [10, -20, 0]);
check('tally lean', [C.tallyLean({ pro: 3, con: 1 }), C.tallyLean({ pro: 0, con: 0 }), C.tallyLean({ pro: 0, con: 2 })], [50, null, -100]);
check('format lean', [C.formatLean(42.4), C.formatLean(-17), C.formatLean(0), C.formatLean(null)], ['+42', '−17', '0', '—']);

done('core');
