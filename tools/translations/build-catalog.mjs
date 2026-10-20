/**
 * data/catalog.json (html-bible/catalog, formatVersion 1) from what is in
 * data/: every translation file in data/translations/ with its size and
 * sha256 computed here, never written by hand; every commentary in
 * data/commentaries/<id>/manifest.json (checked with checkCommentary, each
 * book file against its bytes and sha256), with bytes = the sum of its book
 * files.
 *
 *   node tools/translations/build-catalog.mjs
 *   node tools/translations/build-catalog.mjs DIR    the same for another folder (the test data)
 *
 * Run after any converter (build-kjv.mjs, build-synodal.mjs, build-ebible.mjs,
 * build-ogienko.mjs, build-byztxt.mjs, build-sblgnt.mjs, build-hebrew.mjs,
 * tools/commentaries/lopukhin.py) has rewritten a file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { load, root } from '../load.mjs';
import { dataDir, readTranslation } from './common.mjs';
import { validateTranslation } from './validate.mjs';

const base = process.argv[2] ? resolve(process.argv[2]) : dataDir;
const dir = join(base, 'translations');
const translations = [];
for (const name of readdirSync(dir).filter((n) => /\.json(\.gz)?$/.test(n)).sort()) {
  const file = join(dir, name);
  const bytes = readFileSync(file);
  const t = readTranslation(file);
  const errors = validateTranslation(t);
  if (errors.length) throw new Error(`${name}: ${errors.slice(0, 5).join('; ')}`);
  translations.push({
    id: t.id,
    linkName: t.linkName,
    lang: t.lang,
    name: t.name,
    shortName: t.shortName,
    version: t.version,
    url: `translations/${name}`,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    license: t.license,
  });
}

// The first translation in the reader's language is what a new reader is
// offered, so the KJV and the Synodal go before the others of their language.
const FIRST = ['en-kjv', 'ru-synodal'];
const rank = (t) => (FIRST.includes(t.id) ? FIRST.indexOf(t.id) : FIRST.length);
translations.sort((a, b) => rank(a) - rank(b));

const linkNames = new Set();
for (const t of translations) {
  if (linkNames.has(t.linkName.toLowerCase())) throw new Error(`linkName ${t.linkName} twice`);
  linkNames.add(t.linkName.toLowerCase());
}

const { checkCommentary } = await load('core/pack');
const commentaries = [];
const cdir = join(base, 'commentaries');
for (const name of existsSync(cdir) ? readdirSync(cdir).sort() : []) {
  const file = join(cdir, name, 'manifest.json');
  if (!existsSync(file)) continue;
  const c = checkCommentary(JSON.parse(readFileSync(file, 'utf8')));
  if (c.id !== name) throw new Error(`${name}: manifest id ${c.id}`);
  let bytes = 0;
  for (const book of c.books ?? []) {
    const data = readFileSync(join(cdir, name, book.url));
    if (data.length !== book.bytes || createHash('sha256').update(data).digest('hex') !== book.sha256) {
      throw new Error(`${name}/${book.url}: bytes or sha256 differ from the manifest`);
    }
    bytes += data.length;
  }
  commentaries.push({
    id: c.id,
    lang: c.lang,
    name: c.name,
    version: c.version,
    manifest: `commentaries/${name}/manifest.json`,
    bytes,
    license: c.license ?? '',
  });
}

const catalog = { format: 'html-bible/catalog', formatVersion: 1, translations, commentaries };
writeFileSync(join(base, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`${relative(root, join(base, 'catalog.json'))}: ${[...translations, ...commentaries].map((t) => `${t.id} (${t.bytes} bytes)`).join(', ')}`);
