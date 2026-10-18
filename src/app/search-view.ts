/**
 * Search without losing the place: the list of found verses on the left, the
 * chapter of the chosen one on the right with the verse and the words lit up.
 * A click or ↑/↓ moves through the hits; the page stays. Each hit can be
 * copied with its reference under it, or opened in the reader.
 *
 * A reference typed in the box is offered as a link first. The index is built
 * on the first search and kept for the translation.
 */

import { bookInfo, type AnyBookId } from '../core/books';
import { isNoncanonical, verseText } from '../core/canon';
import { t, tn } from '../core/i18n';
import { formatHuman, parseRef } from '../core/refs';
import { formatRoute, parseRoute } from '../core/route';
import { buildIndex, highlights, isEmptyQuery, parseQuery, type Query, search, type SearchIndex } from '../core/search';
import type { Translation, VerseLoc } from '../core/types';
import { clear, h, icon } from './dom';
import { installedPacks, packMeta, translation } from './packs';
import { settings, uiLang, updateSettings } from './state';
import { anyDialogOpen, toast } from './ui';

let index: SearchIndex | null = null;

async function indexFor(tr: Translation): Promise<SearchIndex> {
  if (index?.translation !== tr.id) index = buildIndex(tr, (loc) => isNoncanonical(tr, loc));
  return index;
}

const PAGE = 50;

interface View {
  tr: Translation;
  q: string;
  scope?: string;
  query: Query;
  hits: VerseLoc[];
  selected: number;
  shown: number;
  list: HTMLElement;
  preview: HTMLElement;
  previewChapter: string | null;
}

let view: View | null = null;

const locId = (loc: VerseLoc) => `${loc.book}.${loc.chapter}.${loc.verse}`;
const clean = (text: string) => text.replace(/[[\]]/g, '');

function bookName(tr: Translation, book: AnyBookId, form: 'name' | 'short' = 'name'): string {
  const b = tr.books.find((x) => x.id === book);
  return (form === 'name' ? b?.name : b?.short) ?? bookInfo(book)?.[uiLang()][form] ?? book;
}

/** "(Евреям 1:3)" — the reference as it goes under a copied verse. */
function refLabel(tr: Translation, loc: VerseLoc): string {
  return `(${bookName(tr, loc.book)} ${loc.chapter}:${loc.verse})`;
}

/** The text with the query's words in <mark>. */
function marked(text: string, query: Query): Node[] {
  const nodes: Node[] = [];
  let at = 0;
  for (const [start, end] of highlights(text, query)) {
    if (start > at) nodes.push(document.createTextNode(text.slice(at, start)));
    nodes.push(h('mark', null, text.slice(start, end)));
    at = end;
  }
  nodes.push(document.createTextNode(text.slice(at)));
  return nodes;
}

async function copyHit(tr: Translation, loc: VerseLoc): Promise<void> {
  const text = `${clean(verseText(tr, loc) ?? '')}\n${refLabel(tr, loc)}`;
  try {
    await navigator.clipboard.writeText(text);
    toast(t('selection', 'Copied'));
  } catch {
    toast(t('search', 'Could not copy.'), 'error');
  }
}

function readLink(tr: Translation, loc: VerseLoc): string {
  return formatRoute({ name: 'read', ref: { linkName: tr.linkName, book: loc.book, parts: [{ chapter: loc.chapter, verse: loc.verse }] } });
}

/* ---------------- the list ---------------- */

function hitElement(v: View, i: number): HTMLElement {
  const { tr, query } = v;
  const loc = v.hits[i]!;
  return h(
    'div',
    { class: 'hit', role: 'option', 'aria-selected': String(i === v.selected), dataset: { i: String(i) }, tabindex: -1, on: { click: (event) => !(event.target as HTMLElement).closest('a, button') && select(i, 'click') } },
    h('div', { class: 'hit-text' }, marked(clean(verseText(tr, loc) ?? ''), query)),
    h(
      'div',
      { class: 'hit-foot' },
      h('span', { class: 'hit-ref' }, refLabel(tr, loc)),
      isNoncanonical(tr, loc) ? h('span', { class: 'badge noncanonical' }, t('reader', 'noncanonical')) : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'icon-button small', title: t('search', 'Copy with the reference'), 'aria-label': t('search', 'Copy with the reference'), on: { click: () => void copyHit(tr, loc) } }, icon('copy')),
      h('a', { class: 'icon-button small', href: readLink(tr, loc), title: t('search', 'Open in the reader'), 'aria-label': t('search', 'Open in the reader') }, icon('book')),
    ),
  );
}

function showMore(v: View): void {
  const more = v.list.querySelector('.more');
  more?.remove();
  let lastBook = v.shown ? v.hits[v.shown - 1]!.book : null;
  const counts = new Map<string, number>();
  for (const hit of v.hits) counts.set(hit.book, (counts.get(hit.book) ?? 0) + 1);
  const end = Math.min(v.hits.length, v.shown + PAGE);
  for (let i = v.shown; i < end; i += 1) {
    const hit = v.hits[i]!;
    if (hit.book !== lastBook) {
      lastBook = hit.book;
      v.list.appendChild(h('div', { class: 'hit-book' }, bookName(v.tr, hit.book), ' ', h('span', { class: 'badge' }, String(counts.get(hit.book) ?? 0))));
    }
    v.list.appendChild(hitElement(v, i));
  }
  v.shown = end;
  if (v.shown < v.hits.length) {
    v.list.appendChild(h('button', { type: 'button', class: 'button more', on: { click: () => showMore(v) } }, t('search', 'Show more')));
  }
}

/* ---------------- the chapter beside it ---------------- */

function renderPreview(v: View, loc: VerseLoc): void {
  const chapterId = `${loc.book}.${loc.chapter}`;
  if (v.previewChapter !== chapterId) {
    v.previewChapter = chapterId;
    const verses = v.tr.books.find((b) => b.id === loc.book)?.chapters[loc.chapter - 1] ?? [];
    const hitsHere = new Map<number, number>();
    v.hits.forEach((hit, i) => hit.book === loc.book && hit.chapter === loc.chapter && hitsHere.set(hit.verse, i));
    clear(
      v.preview,
      h(
        'div',
        { class: 'preview-head' },
        h('h2', null, `${bookName(v.tr, loc.book)} ${loc.chapter}`),
        h('a', { class: 'button small', href: readLink(v.tr, loc) }, icon('book'), t('search', 'Open the chapter')),
      ),
      h(
        'div',
        { class: 'chapter preview-text' },
        verses.map((text, i) => {
          if (!text) return null;
          const verse = i + 1;
          const hitIndex = hitsHere.get(verse);
          return h(
            'p',
            {
              class: ['verse', hitIndex !== undefined && 'hit-verse', isNoncanonical(v.tr, { book: loc.book, chapter: loc.chapter, verse }) && 'noncanonical'],
              dataset: { v: String(verse), ...(hitIndex !== undefined ? { i: String(hitIndex) } : {}) },
              on: hitIndex !== undefined ? { click: () => select(hitIndex, 'click') } : undefined,
            },
            h('span', { class: 'vnum' }, String(verse)),
            h('span', { class: 'vtext' }, hitIndex !== undefined ? marked(clean(text), v.query) : clean(text)),
          );
        }),
      ),
    );
  }
  for (const p of v.preview.querySelectorAll<HTMLElement>('.verse')) p.classList.toggle('highlight', Number(p.dataset.v) === loc.verse);
  const target = v.preview.querySelector<HTMLElement>(`.verse[data-v="${loc.verse}"]`);
  if (target) {
    // Scroll the chapter's own box, not the page.
    const box = v.preview;
    box.scrollTop = Math.max(0, target.offsetTop - box.clientHeight / 3);
  }
}

function select(i: number, how: 'click' | 'key' | 'start'): void {
  const v = view;
  if (!v || i < 0 || i >= v.hits.length) return;
  while (i >= v.shown) showMore(v);
  v.selected = i;
  for (const item of v.list.querySelectorAll<HTMLElement>('.hit')) item.setAttribute('aria-selected', String(Number(item.dataset.i) === i));
  const loc = v.hits[i]!;
  renderPreview(v, loc);
  if (how === 'key') v.list.querySelector<HTMLElement>(`.hit[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  // The chosen hit is part of the address: a reload or Back comes to the same verse.
  if (how !== 'start') history.replaceState(null, '', formatRoute({ name: 'search', q: v.q, ...(v.scope ? { scope: v.scope } : {}), at: locId(loc) }));
}

// ↑/↓ move through the hits, also from the search box; Enter there is the box's own.
document.addEventListener('keydown', (event) => {
  if (!view || anyDialogOpen() || parseRoute(location.hash).name !== 'search') return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const target = event.target as HTMLElement;
  if (target.closest('textarea, select') || (target.closest('input') && target.id !== 'search-input')) return;
  event.preventDefault();
  select(view.selected + (event.key === 'ArrowDown' ? 1 : -1), 'key');
});

/* ---------------- the page ---------------- */

export async function openSearch(container: HTMLElement, q: string, scope?: string, at?: string): Promise<void> {
  view = null;
  const id = settings.translation && packMeta(settings.translation) ? settings.translation : installedPacks('translation')[0]?.id;
  const tr = id ? await translation(id) : undefined;
  const page = h('div', { class: 'page search-page' });
  clear(container, h('div', { class: 'view-scroll' }, page));
  if (!tr) {
    page.appendChild(h('div', { class: 'empty' }, t('reader', 'No translation is installed.')));
    return;
  }

  const ref = parseRef(q);
  if (ref) {
    page.appendChild(h('a', { class: 'ref-suggestion', href: formatRoute({ name: 'read', ref }) }, h('b', null, t('search', 'Go to')), formatHuman(ref, uiLang(), 'name'), ref.linkName ? ` (${ref.linkName})` : ''));
  }

  const chip = (label: string, value: string | undefined) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String((scope ?? '') === (value ?? '')), on: { click: () => (location.hash = formatRoute({ name: 'search', q, ...(value ? { scope: value } : {}) })) } }, label);
  const noncanonical = h('input', { type: 'checkbox', checked: settings.searchNoncanonical });
  noncanonical.addEventListener('change', () => {
    updateSettings({ searchNoncanonical: noncanonical.checked });
    void openSearch(container, q, scope);
  });
  const count = h('span', { class: 'search-count' });
  page.appendChild(
    h(
      'div',
      { class: 'search-head' },
      h('div', { class: 'chips' }, chip(t('search', 'Everywhere'), undefined), chip(t('search', 'Old Testament'), 'OT'), chip(t('search', 'New Testament'), 'NT')),
      tr.books.some((b) => b.canonical === false) ? h('label', { class: 'check' }, noncanonical, t('search', 'Including noncanonical')) : null,
      count,
    ),
  );

  const query = parseQuery(q);
  if (isEmptyQuery(query)) {
    if (!ref) page.appendChild(h('p', { class: 'hint' }, t('search', 'A part of a word is enough: «ипоста» finds «ипостаси». "In quotes" — exactly that word or phrase; -word leaves it out.')));
    return;
  }
  const started = performance.now();
  const book = scope && /^[1-3A-Z]{3}$/.test(scope) ? (scope as AnyBookId) : undefined;
  const result = search(await indexFor(tr), query, {
    includeNoncanonical: settings.searchNoncanonical,
    ...(scope === 'OT' || scope === 'NT' ? { testament: scope } : {}),
    ...(book ? { books: new Set([book]) } : {}),
  });
  const ms = Math.round(performance.now() - started);
  count.textContent = `${tn('search', '{count} verse found', '{count} verses found', result.total)} · ${tr.shortName} · ${ms} ms`;
  if (!result.total) {
    page.appendChild(h('div', { class: 'empty' }, t('search', 'Nothing found. A part of a word is enough; check the spelling or the filters.')));
    return;
  }

  const list = h('div', { class: 'search-results', role: 'listbox', 'aria-label': t('search', 'Found verses') });
  const preview = h('aside', { class: 'search-preview', 'aria-label': t('search', 'The chapter') });
  page.appendChild(h('div', { class: 'search-layout' }, h('div', null, list, h('p', { class: 'hint hide-touch' }, t('search', '↑ ↓ — the previous and the next verse'))), preview));
  view = { tr, q, ...(scope ? { scope } : {}), query, hits: result.hits, selected: 0, shown: 0, list, preview, previewChapter: null };
  showMore(view);
  const start = at ? result.hits.findIndex((hit) => locId(hit) === at) : 0;
  select(Math.max(0, start), 'start');
  if (start > 0) list.querySelector<HTMLElement>(`.hit[data-i="${start}"]`)?.scrollIntoView({ block: 'center' });
}
