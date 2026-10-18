/**
 * The Markdown tree (core/markdown.ts) → DOM nodes. Text only ever goes in as
 * text nodes; links and images get addresses core/markdown.ts already checked.
 * A verse reference becomes a link to it, with the verse's text as its title
 * when the current translation is loaded.
 */

import { formatHuman, type ParsedRef, parseLink } from '../core/refs';
import { type Block, type Inline, parseMarkdown } from '../core/markdown';
import { formatRoute } from '../core/route';
import { h } from './dom';
import { uiLang } from './state';

export type RefTitle = (node: Extract<Inline, { t: 'ref' }>) => string | undefined;

/** Renumbers a reference written in a text's own numbering into canonical; undefined — not a link (noncanonical). */
export type RefMap = (ref: ParsedRef) => ParsedRef | undefined;

let mapRef: RefMap | undefined;

function inline(nodes: Inline[], refTitle?: RefTitle): Node[] {
  return nodes.map((node): Node => {
    switch (node.t) {
      case 'text':
        return document.createTextNode(node.v);
      case 'br':
        return h('br');
      case 'b':
        return h('strong', null, inline(node.c, refTitle));
      case 'i':
        return h('em', null, inline(node.c, refTitle));
      case 'a':
        return h('a', { href: node.href, target: '_blank', rel: 'noopener noreferrer nofollow ugc', class: node.insecure ? 'insecure' : undefined }, inline(node.c, refTitle));
      case 'img':
        return h('img', { src: node.src, alt: node.alt, loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' });
      case 'ref': {
        const ref = mapRef ? mapRef(node.ref) : node.ref;
        const label = parseLink(node.text) ? formatHuman(node.ref, uiLang()) : node.text;
        if (!ref) return document.createTextNode(label);
        return h(
          'a',
          { href: formatRoute({ name: 'read', ref }), class: 'verse-link', title: refTitle?.({ ...node, ref }) ?? formatHuman(node.ref, uiLang()) },
          // [[Jhn3-17]] reads as «Ин 3:17»; a reference written in words stays as written.
          label,
        );
      }
    }
  });
}

function blocks(list: Block[], refTitle?: RefTitle): Node[] {
  return list.map((block): Node => {
    switch (block.t) {
      case 'p':
        return h('p', null, inline(block.c, refTitle));
      case 'quote':
        return h('blockquote', null, blocks(block.c, refTitle));
      case 'ul':
        return h('ul', null, block.items.map((item) => h('li', null, inline(item, refTitle))));
    }
  });
}

export function renderMarkdown(source: string, refTitle?: RefTitle, refMap?: RefMap): HTMLElement {
  mapRef = refMap;
  try {
    return h('div', { class: 'md' }, blocks(parseMarkdown(source), refTitle));
  } finally {
    mapRef = undefined;
  }
}
