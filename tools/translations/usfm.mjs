/**
 * A small USFM reader for the eBible.org packages (eng-kjv, russyn): just
 * enough of USFM to get books → chapters → verses of plain text.
 *
 * Kept: verse text, \add … \add* (translator-added words) as [ … ].
 * Dropped: footnotes and cross references (\f … \f*, \x … \x*), Strong's
 * attributes of \w, headings, introductions, book titles, paragraph markers.
 * Psalm titles (\d) are not verses in USFM; the caller decides what to do with
 * them, so they come back separately per chapter.
 *
 * Not a CLI: imported by the converters (build-kjv.mjs, build-ebible.mjs,
 * build-synodal.mjs, build-ogienko.mjs).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Paragraph-level markers whose whole line is not verse text. */
const SKIP_LINE = /^\\(id|ide|h|toc\d|mt\d?|ms\d?|imt\d?|is\d?|ip|ipr|iot|io\d?|s\d?|sr|r|rem|sts|cl|cp|ca|va|mr|d)\b/;

export function cleanInline(text) {
  return (
    text
      // Footnotes, cross references, endnotes: drop with their content.
      .replace(/\\(f|x|fe)\s.*?\\\1\*/gs, '')
      // Translator additions → [ … ]; the closing marker may be nested markers apart.
      .replace(/\\\+?add\s/g, '[')
      .replace(/\\\+?add\*/g, ']')
      // \w word|strong="H1234"\w* → word
      .replace(/\\\+?w\s([^\\|]*?)(\|[^\\]*?)?\\\+?w\*/g, '$1')
      // Every other character style: keep the content, drop the markers.
      .replace(/\\\+?[a-z]+\d*\*/g, '')
      .replace(/\\\+?[a-z]+\d*\s?/g, '')
  );
}

/** "[a [b] c]" → "[a b c]": the format has one level of added words. */
export function flattenBrackets(text) {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '[') {
      depth += 1;
      if (depth > 1) continue;
    } else if (ch === ']') {
      depth -= 1;
      if (depth > 0) continue;
    }
    out += ch;
  }
  return out;
}

export function normalizeSpace(text) {
  return text
    .replace(/﻿/g, '')
    .replace(/[  -​ \t\r\n]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\[ /g, '[')
    .replace(/ \]/g, ']')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
}

/**
 * Makes every verse of a chapter balanced in [ ], in place, since the reader
 * shows and hides added words one verse at a time. A bracket closed in a later
 * verse is closed at the end of each verse and reopened in the next — unless
 * `across` is false, for editions whose brackets over several verses mark a
 * doubtful passage, not added words: then both ends are dropped. A bracket
 * never closed, or a closing one never opened, is dropped. Returns the verse
 * numbers of each case, for the converter's report.
 */
export function balanceChapter(verses, { across = true } = {}) {
  const report = { spanning: [], stray: [], unopened: [] };
  let carry = false;
  for (let v = 0; v < verses.length; v += 1) {
    let text = carry ? `[${verses[v]}` : verses[v];
    carry = false;
    let depth = 0;
    let kept = '';
    for (const ch of text) {
      if (ch === ']' && depth === 0) {
        report.unopened.push(v + 1);
        continue;
      }
      depth += ch === '[' ? 1 : ch === ']' ? -1 : 0;
      kept += ch;
    }
    text = kept;
    if (depth > 0) {
      // Closed later in the chapter? Then close here and reopen next verse.
      const rest = verses.slice(v + 1).join(' ');
      if (across && rest.indexOf(']') >= 0 && (rest.indexOf('[') < 0 || rest.indexOf(']') < rest.indexOf('['))) {
        report.spanning.push(v + 1);
        text = `${text}]`;
        carry = true;
      } else {
        const at = text.lastIndexOf('[');
        text = text.slice(0, at) + text.slice(at + 1);
        report.stray.push(v + 1);
      }
    }
    verses[v] = normalizeSpace(text.replace(/\[\]/g, ''));
  }
  return report;
}

/**
 * Parses one USFM book. Returns { id, chapters: string[][], titles: Map<chapter, string> }.
 * Verses are indexed by their number (1-based); gaps stay '' and are reported by the caller.
 */
export function parseUsfmBook(source) {
  const text = source.replace(/^﻿/, '');
  const idMatch = /^\\id\s+([A-Z0-9]{3})/m.exec(text);
  if (!idMatch) throw new Error('USFM without \\id');
  const chapters = [];
  const titles = new Map();
  let chapter = 0;
  let verse = 0;
  let buffer = null; // collects the current verse's raw text
  const flush = () => {
    if (buffer !== null && chapter > 0 && verse > 0) {
      const row = chapters[chapter - 1];
      const clean = normalizeSpace(flattenBrackets(cleanInline(buffer)));
      row[verse - 1] = row[verse - 1] ? `${row[verse - 1]} ${clean}` : clean;
    }
    buffer = null;
  };
  // Markers can sit mid-line (\v after \q1 etc.), so split on every \c and \v.
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^\\d\b/.test(line)) {
      flush();
      const title = normalizeSpace(cleanInline(line.replace(/^\\d\s*/, '')));
      if (chapter > 0) titles.set(chapter, titles.has(chapter) ? `${titles.get(chapter)} ${title}` : title);
      continue;
    }
    if (SKIP_LINE.test(line)) {
      flush();
      continue;
    }
    // Paragraph/poetry markers at the start: the verse goes on.
    line = line.replace(/^\\(p|m|pi\d?|mi|nb|q\d?|qc|qr|qm\d?|li\d?|pc|b|pmo|pm|pmc|pmr|po|cls|tr|tc\d|th\d)\b\s*/, '');
    const parts = line.split(/(\\c\s+\d+|\\v\s+\d+[a-z]?(?:-\d+)?\s?)/);
    for (const part of parts) {
      const c = /^\\c\s+(\d+)/.exec(part);
      if (c) {
        flush();
        chapter = Number(c[1]);
        verse = 0;
        while (chapters.length < chapter) chapters.push([]);
        continue;
      }
      const v = /^\\v\s+(\d+)/.exec(part);
      if (v) {
        flush();
        verse = Number(v[1]);
        buffer = '';
        continue;
      }
      if (buffer !== null) buffer += ` ${part}`;
    }
  }
  flush();
  for (const row of chapters) for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = '';
  return { id: idMatch[1], chapters, titles };
}

/** Every *.usfm in a directory, parsed, keyed by USFM book id. */
export function readUsfmDir(dir) {
  const books = new Map();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.usfm')).sort()) {
    const book = parseUsfmBook(readFileSync(join(dir, name), 'utf8'));
    books.set(book.id, book);
  }
  return books;
}
