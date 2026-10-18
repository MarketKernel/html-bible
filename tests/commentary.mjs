/**
 * The Lopukhin commentary in data/commentaries/ru-lopukhin/ (built by
 * tools/commentaries/lopukhin.py): the manifest and every book file pass the
 * app's own checks, refs are canonical and inside KJV verse counts, the text
 * is the Markdown subset with no HTML left, sizes and hashes match, the books
 * covered, control entries, and the catalog entry.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checker, load, needData, root } from '../tools/load.mjs';

needData('commentary', 'commentaries/ru-lopukhin/manifest.json', 'catalog.json');
const { check, done } = checker();
const { checkCommentary, checkCommentaryBook, isCanonicalRef } = await load('core/pack');
const { KJV_COUNTS } = await load('core/versification/kjv-counts');
const { CANONICAL_BOOKS } = await load('core/books');
const { parseMarkdown, plainText } = await load('core/markdown');

const dir = join(root, 'data', 'commentaries', 'ru-lopukhin');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

const passes = (fn, value) => {
  try {
    fn(value);
    return true;
  } catch (e) {
    return String(e.message ?? e);
  }
};

// Manifest
check('manifest: checkCommentary', passes(checkCommentary, manifest), true);
check('manifest: header', [manifest.format, manifest.formatVersion, manifest.id, manifest.version, manifest.lang, manifest.name, manifest.license], [
  'html-bible/commentary', 1, 'ru-lopukhin', '1.0.0', 'ru', 'Толковая Библия Лопухина', 'Public domain',
]);
check('manifest: source is https', /^https:\/\//.test(manifest.source ?? ''), true);
check('manifest: no inline entries', manifest.entries, undefined);

// Books covered. The source (MyBible module "Лоп-к") comments every canonical
// book; it has no deuterocanonical ones, and those are not allowed here anyway.
const EXPECTED_BOOKS = [...CANONICAL_BOOKS]; // all 66, GEN … REV
const EMPTY_BOOKS = []; // canonical books without entries: none
check('books: the expected list, in canonical order', manifest.books.map((b) => b.id), EXPECTED_BOOKS.filter((id) => !EMPTY_BOOKS.includes(id)));
check('books: files on disk = manifest', readdirSync(dir).filter((n) => n.endsWith('.json.gz')).sort(), manifest.books.map((b) => b.url).sort());

// Book files
const ENTRY_KEYS = new Set(['ref', 'md']);
let entries = 0;
let totalBytes = 0;
const bad = { book: [], hash: [], keys: [], ref: [], bounds: [], html: [], markup: [], long: [], empty: [], order: [] };
const byBook = new Map();
const pos = (key) => {
  const [, c, v] = key.split('.');
  return Number(c) * 1000 + Number(v);
};
for (const item of manifest.books) {
  const raw = readFileSync(join(dir, item.url));
  totalBytes += raw.length;
  if (raw.length !== item.bytes || createHash('sha256').update(raw).digest('hex') !== item.sha256) bad.hash.push(item.id);
  check(`${item.id}: gzip, mtime 0`, [raw[0], raw[1], raw.readUInt32LE(4)], [0x1f, 0x8b, 0]);
  const book = JSON.parse(gunzipSync(raw).toString('utf8'));
  const ok = passes(checkCommentaryBook, book);
  if (ok !== true || book.book !== item.id || book.commentary !== 'ru-lopukhin' || book.entries.length !== item.entries) bad.book.push(`${item.id}: ${ok}`);
  byBook.set(item.id, book.entries);
  entries += book.entries.length;
  let last = 0;
  for (const e of book.entries) {
    if (Object.keys(e).some((k) => !ENTRY_KEYS.has(k))) bad.keys.push(e.ref);
    if (!isCanonicalRef(e.ref)) bad.ref.push(e.ref);
    const ends = e.ref.split('-');
    for (const end of ends) {
      const [b, c, v] = end.split('.');
      if (b !== item.id || !(Number(v) <= (KJV_COUNTS[b]?.[Number(c) - 1] ?? 0))) bad.bounds.push(e.ref);
    }
    if (pos(ends[0]) < last) bad.order.push(e.ref);
    last = pos(ends[0]);
    // No HTML: "<" may stand in text, but never start something tag-like.
    if (/<\/?[A-Za-z!][^>]*>|<[A-Za-z]/.test(e.md) || /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i.test(e.md)) bad.html.push(e.ref);
    if (e.md.length > 200_000) bad.long.push(e.ref);
    if (!e.md.trim()) bad.empty.push(e.ref);
    // The app's parser must take all the markup: nothing of it left in the text.
    const text = plainText(parseMarkdown(e.md));
    if (/\*\*|(^|\s)_\S|\S_(\s|$)/.test(text)) bad.markup.push(e.ref);
  }
}
for (const [name, list] of Object.entries(bad)) check(`entries: ${name} problems (first 5)`, list.slice(0, 5), []);
check('entries: total', entries, manifest.books.reduce((n, b) => n + b.entries, 0));
check('entries: at least 16000', entries >= 16000, true);
check('entries: size 5–10 MB gzipped', totalBytes > 5e6 && totalBytes < 10e6, true);

// Control entries: the source comments these verses.
const covering = (book, chapter, verse) =>
  (byBook.get(book) ?? []).filter((e) => {
    const [from, to = from] = e.ref.split('-');
    const k = chapter * 1000 + verse;
    return pos(from) <= k && k <= pos(to);
  });
const has = (book, c, v, words) => covering(book, c, v).some((e) => e.md.includes(words));
check('control: GEN.1.1 — the introduction', has('GEN', 1, 1, 'Понятие о Библии'), true);
check('control: GEN.1.1 — "В начале"', has('GEN', 1, 1, 'В начале'), true);
check('control: MAT.1.1 — the genealogy', has('MAT', 1, 1, 'родословием'), true);
check('control: JHN.3.16', has('JHN', 3, 16, 'Единородный'), true);
// Synodal Ps 50:3–5 is KJV Ps 51:1–3 (two title verses before verse 1).
check('control: Synodal Ps 50:3–5 → PSA.51.1-PSA.51.3', (byBook.get('PSA') ?? []).some((e) => e.ref === 'PSA.51.1-PSA.51.3'), true);
check('control: no comment lands on the noncanonical Ps 151', (byBook.get('PSA') ?? []).every((e) => !e.ref.startsWith('PSA.151.')), true);

// Catalog
const catalog = JSON.parse(readFileSync(join(root, 'data', 'catalog.json'), 'utf8'));
const listed = catalog.commentaries.find((c) => c.id === 'ru-lopukhin');
check('catalog: lists ru-lopukhin', listed && { ...listed, bytes: undefined }, {
  id: 'ru-lopukhin', lang: 'ru', name: 'Толковая Библия Лопухина', version: '1.0.0',
  manifest: 'commentaries/ru-lopukhin/manifest.json', bytes: undefined, license: 'Public domain',
});
check('catalog: bytes = sum of book files', listed?.bytes, totalBytes);
check('catalog: manifest path exists', existsSync(join(root, 'data', listed?.manifest ?? '-')), true);

done('commentary');
