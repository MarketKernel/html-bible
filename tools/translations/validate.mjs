/**
 * Checks a translation file (html-bible/translation, formatVersion 1): format,
 * known book ids, non-empty chapters, clean text (no BOM, HTML, entities,
 * double spaces, unbalanced [ ]), and for a scheme with a versification table
 * that the book's `noncanonical` ranges equal the table's.
 *
 *   node tools/translations/validate.mjs data/translations/en-kjv.json.gz data/translations/ru-synodal.json.gz
 *
 * Used by the converters before they write, and by tests/translations.mjs.
 */
import { pathToFileURL } from 'node:url';
import { load } from '../load.mjs';
import { books, counts, readTranslation } from './common.mjs';

const { SYNODAL_NONCANONICAL } = await load('core/versification/synodal');
const TABLES = { kjv: {}, synodal: SYNODAL_NONCANONICAL };

const REQUIRED = ['id', 'linkName', 'version', 'lang', 'name', 'shortName', 'license', 'source', 'versification'];

/** Problems of one verse's text, or [] when clean. */
export function textProblems(text) {
  const problems = [];
  if (typeof text !== 'string') return ['not a string'];
  if (text.includes('﻿')) problems.push('BOM');
  if (/<\/?[a-zA-Z][^>]*>/.test(text)) problems.push('HTML tag');
  if (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(text)) problems.push('HTML entity');
  if (/\\[a-z]+/.test(text)) problems.push('USFM marker');
  if (/ {2,}/.test(text)) problems.push('double space');
  if (/^\s|\s$/.test(text)) problems.push('outer space');
  if (/[\t\r\n ​]/.test(text)) problems.push('odd whitespace');
  if (/�|Ã.|Ð.|Ñ./.test(text)) problems.push('broken encoding');
  if (/[¶]/.test(text)) problems.push('pilcrow');
  let depth = 0;
  for (const ch of text) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    if (depth < 0 || depth > 1) break;
  }
  if (depth !== 0) problems.push('unbalanced [ ]');
  return problems;
}

/** All problems of a translation object, as short strings ([] when valid). */
export function validateTranslation(t) {
  const errors = [];
  if (t.format !== 'html-bible/translation') errors.push(`format: ${t.format}`);
  if (t.formatVersion !== 1) errors.push(`formatVersion: ${t.formatVersion}`);
  for (const field of REQUIRED) if (typeof t[field] !== 'string' || !t[field]) errors.push(`missing ${field}`);
  if (!/^[A-Za-z0-9]+$/.test(t.linkName ?? '')) errors.push(`linkName: ${t.linkName}`);
  if (!Array.isArray(t.books) || !t.books.length) return [...errors, 'no books'];
  const table = TABLES[t.versification];
  const seen = new Set();
  let textErrors = 0;
  for (const book of t.books) {
    const where = book.id;
    if (!books.isBookId(book.id)) errors.push(`${where}: unknown book id`);
    if (seen.has(book.id)) errors.push(`${where}: twice`);
    seen.add(book.id);
    for (const field of ['name', 'short']) if (typeof book[field] !== 'string' || !book[field]) errors.push(`${where}: missing ${field}`);
    const canonical = book.canonical !== false;
    if (canonical !== books.isCanonicalBook(book.id)) errors.push(`${where}: canonical flag ${book.canonical}`);
    if (!Array.isArray(book.chapters) || !book.chapters.length) {
      errors.push(`${where}: no chapters`);
      continue;
    }
    book.chapters.forEach((chapter, c) => {
      if (!Array.isArray(chapter) || !chapter.length) errors.push(`${where} ${c + 1}: empty chapter`);
      else if (chapter.every((verse) => verse === '')) errors.push(`${where} ${c + 1}: only empty verses`);
      chapter.forEach((verse, v) => {
        if (verse === '') return;
        const problems = textProblems(verse);
        if (problems.length && textErrors++ < 20) errors.push(`${where} ${c + 1}:${v + 1}: ${problems.join(', ')}`);
      });
    });
    for (const range of book.noncanonical ?? []) {
      const m = /^(\d+)\.(\d+)-(\d+)\.(\d+)$/.exec(range);
      if (!m) {
        errors.push(`${where}: bad noncanonical range ${range}`);
        continue;
      }
      const [c1, v1, c2, v2] = m.slice(1).map(Number);
      if (!book.chapters[c1 - 1]?.[v1 - 1] || !book.chapters[c2 - 1]?.[v2 - 1]) errors.push(`${where}: range ${range} outside the text`);
    }
    if (table) {
      const expected = JSON.stringify(table[book.id] ?? []);
      const actual = JSON.stringify(book.noncanonical ?? []);
      if (expected !== actual) errors.push(`${where}: noncanonical ${actual}, versification table says ${expected}`);
    }
  }
  if (textErrors > 20) errors.push(`… ${textErrors - 20} more text problems`);
  if (table) {
    for (const id of Object.keys(table)) if (!seen.has(id)) errors.push(`${id}: in the versification table, not in the file`);
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let failed = false;
  for (const file of process.argv.slice(2)) {
    const t = readTranslation(file);
    const errors = validateTranslation(t);
    const c = counts(t);
    console.log(`${file}: ${c.books} books, ${c.chapters} chapters, ${c.verses} verses — ${errors.length ? `${errors.length} problems` : 'valid'}`);
    for (const error of errors.slice(0, 30)) console.log(`  ${error}`);
    if (errors.length) failed = true;
  }
  if (failed) process.exit(1);
}
