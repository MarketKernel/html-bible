/**
 * The Markdown subset comments and discussion points are written in:
 * **bold**, *italic*, [text](https://…), ![caption](https://…), paragraphs,
 * line breaks, "> quote", "- list", [[Mat3-3]] and verse references in plain
 * text («Ин 3:16»).
 *
 * It is parsed into a tree, never into HTML: the page builds DOM nodes from
 * the tree with textContent (app/render-md.ts), so no text anyone writes —
 * the user, a downloaded commentary, a stranger's JSON — can become markup.
 * Addresses are checked here: only https: (and http:, marked insecure) get a
 * link or an image; anything else stays text.
 */

import { findRefsInText, type ParsedRef, parseRef } from './refs';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'a'; href: string; insecure: boolean; c: Inline[] }
  | { t: 'img'; src: string; alt: string }
  | { t: 'ref'; text: string; ref: ParsedRef }
  | { t: 'br' };

export type Block = { t: 'p'; c: Inline[] } | { t: 'quote'; c: Block[] } | { t: 'ul'; items: Inline[][] };

export const MAX_LENGTH = 5000;
export const MAX_IMAGES = 5;

/** A web address a link or image may have; undefined for anything else (javascript:, data:, relative…). */
export function safeUrl(raw: string): { href: string; insecure: boolean } | undefined {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text)) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (!url.hostname) return undefined;
    return { href: url.href, insecure: url.protocol === 'http:' };
  } catch {
    return undefined;
  }
}

/** Plain text with verse references made into ref nodes and bare web addresses into links. */
function textNodes(text: string, out: Inline[]): void {
  if (!text) return;
  const pieces: { index: number; length: number; node: Inline }[] = [];
  for (const found of findRefsInText(text)) {
    pieces.push({ index: found.index, length: found.length, node: { t: 'ref', text: text.slice(found.index, found.index + found.length), ref: found.ref } });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>()"«»]+[^\s<>()"«».,;:!?]/g)) {
    const url = safeUrl(match[0]);
    if (!url || match.index === undefined) continue;
    if (pieces.some((p) => match.index! < p.index + p.length && p.index < match.index! + match[0].length)) continue;
    pieces.push({ index: match.index, length: match[0].length, node: { t: 'a', href: url.href, insecure: url.insecure, c: [{ t: 'text', v: match[0] }] } });
  }
  pieces.sort((a, b) => a.index - b.index);
  let at = 0;
  for (const piece of pieces) {
    if (piece.index < at) continue;
    if (piece.index > at) push(out, { t: 'text', v: text.slice(at, piece.index) });
    out.push(piece.node);
    at = piece.index + piece.length;
  }
  if (at < text.length) push(out, { t: 'text', v: text.slice(at) });
}

/** Adjacent text nodes merge. */
function push(out: Inline[], node: Inline): void {
  const last = out.at(-1);
  if (node.t === 'text' && last?.t === 'text') last.v += node.v;
  else out.push(node);
}

/** The index of the bracket closing the one at `open`, counting nesting; -1 if none. */
function closing(s: string, open: number, left: string, right: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === left) depth += 1;
    else if (s[i] === right) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseInline(s: string, depth = 0, links = true): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    textNodes(text, out);
    text = '';
  };
  // Deep nesting is not something a person writes; past it everything is text.
  if (depth > 8) {
    textNodes(s, out);
    return out;
  }
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && /[\\*_[\]()!>#-]/.test(s[i + 1]!)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i += 1;
      continue;
    }
    // [[Mat3-3]] — a verse reference written as a link
    if (s.startsWith('[[', i)) {
      const end = s.indexOf(']]', i + 2);
      if (end > 0) {
        const inner = s.slice(i + 2, end);
        const ref = parseRef(inner);
        if (ref) {
          flush();
          out.push({ t: 'ref', text: inner, ref });
          i = end + 2;
          continue;
        }
      }
    }
    // ![alt](url)
    if (ch === '!' && s[i + 1] === '[') {
      const close = closing(s, i + 1, '[', ']');
      if (close > 0 && s[close + 1] === '(') {
        const end = closing(s, close + 1, '(', ')');
        const url = end > 0 ? safeUrl(s.slice(close + 2, end)) : undefined;
        if (url && !url.insecure) {
          flush();
          out.push({ t: 'img', src: url.href, alt: s.slice(i + 2, close).replace(/\\(.)/g, '$1') });
          i = end + 1;
          continue;
        }
      }
    }
    // [text](url)
    if (ch === '[' && links) {
      const close = closing(s, i, '[', ']');
      if (close > 0 && s[close + 1] === '(') {
        const end = closing(s, close + 1, '(', ')');
        const url = end > 0 ? safeUrl(s.slice(close + 2, end)) : undefined;
        if (url) {
          flush();
          out.push({ t: 'a', href: url.href, insecure: url.insecure, c: parseInline(s.slice(i + 1, close), depth + 1, false) });
          i = end + 1;
          continue;
        }
      }
    }
    // **bold**
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'b', c: parseInline(s.slice(i + 2, end), depth + 1, links) });
        i = end + 2;
        continue;
      }
    }
    // *italic* or _italic_ (not inside a word for "_", so snake_case stays)
    if ((ch === '*' || (ch === '_' && !/\w/.test(s[i - 1] ?? ''))) && s[i + 1] !== ch && s[i + 1] !== ' ') {
      let end = i + 1;
      while (end < s.length) {
        end = s.indexOf(ch, end);
        if (end < 0) break;
        if (s[end + 1] !== ch && s[end - 1] !== ' ' && (ch !== '_' || !/\w/.test(s[end + 1] ?? ''))) break;
        end += 1;
      }
      if (end > i + 1) {
        flush();
        out.push({ t: 'i', c: parseInline(s.slice(i + 1, end), depth + 1, links) });
        i = end + 1;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ t: 'p', c: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      endParagraph();
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line) && depth < 3) {
      endParagraph();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ t: 'quote', c: parseMarkdown(quoted.join('\n'), depth + 1) });
      continue;
    }
    if (/^\s*[-*]\s+\S/.test(line)) {
      endParagraph();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+\S/.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.replace(/^\s*[-*]\s+/, '')));
        i += 1;
      }
      blocks.push({ t: 'ul', items });
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  endParagraph();
  return blocks;
}

/** Images in a tree — to hold a comment to MAX_IMAGES. */
export function countImages(blocks: Block[]): number {
  let count = 0;
  const inline = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.t === 'img') count += 1;
      else if (node.t === 'b' || node.t === 'i' || node.t === 'a') inline(node.c);
    }
  };
  for (const block of blocks) {
    if (block.t === 'p') inline(block.c);
    else if (block.t === 'ul') block.items.forEach(inline);
    else count += countImages(block.c);
  }
  return count;
}

/** The text without markup — for previews and search. */
export function plainText(blocks: Block[]): string {
  const inline = (nodes: Inline[]): string =>
    nodes
      .map((node) => {
        switch (node.t) {
          case 'text':
            return node.v;
          case 'b':
          case 'i':
          case 'a':
            return inline(node.c);
          case 'img':
            return node.alt;
          case 'ref':
            return node.text;
          case 'br':
            return ' ';
        }
      })
      .join('');
  return blocks
    .map((block) => (block.t === 'p' ? inline(block.c) : block.t === 'ul' ? block.items.map(inline).join(' ') : plainText(block.c)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
