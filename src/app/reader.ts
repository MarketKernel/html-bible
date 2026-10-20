/**
 * The Bible tab: a chapter of the current translation, a parallel one beside
 * it if chosen, verse selection and its actions, the markers of comments (💬)
 * and of discussions (⚖) on verses.
 *
 * A link names a translation by its linkName (Synodal_Mat3-3): the chapter
 * opens in that one, as its author saw it. A link without one is in canonical
 * numbering and opens in the current translation, renumbered.
 */

import { type AnyBookId, bookInfo, type BookId, isCanonicalBook } from '../core/books';
import { canonicalRefToNative, fromKey, isNoncanonical, keyOf, refToRanges, textAttrs, toKey, verseCount, verseText } from '../core/canon';
import { t } from '../core/i18n';
import { formatHuman, formatLink, type ParsedRef, partsFromVerses, versesInChapter } from '../core/refs';
import { formatRoute } from '../core/route';
import type { RefRange, Translation, VerseLoc } from '../core/types';
import { chapterMarkers, openCommentEditor, openVerseComments } from './comments';
import { clear, h, icon, isTouch } from './dom';
import { addToDiscussion, chapterTags, openVerseDiscussions } from './discussions';
import { closePanel, panelElement } from './panel';
import { fetchCatalog, installCatalogTranslation, installedPacks, packMeta, translation, translationByLinkName } from './packs';
import { settings, uiLang, updateSettings } from './state';
import { confirmDialog, dialog, menu, toast } from './ui';

interface ReaderState {
  tr: Translation;
  par: Translation | null;
  book: AnyBookId;
  chapter: number;
  highlight: Set<number>;
  selected: Set<number>;
  lastClicked: number | null;
}

let state: ReaderState | null = null;
let root: HTMLElement | null = null;
let chapterElement: HTMLElement | null = null;
let renderToken = 0;

export function readerState(): Readonly<ReaderState> | null {
  return state;
}

/* ---------------- opening ---------------- */

async function currentTranslation(): Promise<Translation | undefined> {
  const id = settings.translation && packMeta(settings.translation) ? settings.translation : installedPacks('translation')[0]?.id;
  return id ? translation(id) : undefined;
}

/** A link names a translation that is not installed: offer to download it. */
async function offerTranslation(linkName: string): Promise<Translation | undefined> {
  let entry;
  try {
    entry = (await fetchCatalog()).translations.find((e) => e.linkName.toLowerCase() === linkName.toLowerCase());
  } catch {
    entry = undefined;
  }
  if (!entry) {
    toast(t('reader', 'The translation “{name}” is not installed; shown in yours.', { name: linkName }));
    return undefined;
  }
  const yes = await confirmDialog(
    t('reader', 'Download “{name}”?', { name: entry.name }),
    t('reader', 'The link is to a verse in “{name}”, which is not on this device yet.', { name: entry.name }),
    t('reader', 'Download'),
  );
  if (!yes) return undefined;
  try {
    const meta = await installCatalogTranslation(entry);
    return translation(meta.id);
  } catch (error) {
    toast((error as Error).message, 'error');
    return undefined;
  }
}

export interface OpenOptions {
  ref?: ParsedRef;
  notes?: boolean;
  par?: string;
  comment?: string;
  /** Keep the page where it is (navigating between chapters keeps the top). */
  scroll?: boolean;
}

export async function openReader(container: HTMLElement, options: OpenOptions = {}): Promise<void> {
  const token = ++renderToken;
  let tr = await currentTranslation();
  let book: AnyBookId | undefined;
  let chapter = 1;
  let highlight: number[] = [];

  const ref = options.ref;
  if (ref) {
    let native: ParsedRef | undefined;
    if (ref.linkName) {
      const named = translationByLinkName(ref.linkName);
      const target = named ? await translation(named.id) : await offerTranslation(ref.linkName);
      if (target) {
        tr = target;
        native = ref;
      } else if (tr && isCanonicalBook(ref.book)) {
        // Shown in the user's translation: numbers taken as canonical.
        native = canonicalRefToNative(tr, ref);
      }
    } else if (tr) {
      native = isCanonicalBook(ref.book) ? canonicalRefToNative(tr, ref) : ref;
    }
    if (native) {
      book = native.book;
      chapter = native.parts[0]?.chapter ?? 1;
      if (tr) highlight = versesInChapter(native.parts.filter((p) => p.verse !== undefined), chapter, verseCount(tr, book, chapter));
    }
  }
  if (token !== renderToken) return;
  if (!tr) {
    clear(container, h('div', { class: 'view-scroll' }, h('div', { class: 'empty' }, t('reader', 'No translation is installed.'))));
    return;
  }
  if (tr.id !== settings.translation) updateSettings({ translation: tr.id });

  if (!book) {
    const last = settings.lastRead;
    if (last && tr.books.some((b) => b.id === last.book)) {
      book = last.book as AnyBookId;
      chapter = last.chapter;
    } else {
      book = tr.books[0]!.id;
    }
  }
  const trBook = tr.books.find((b) => b.id === book) ?? tr.books[0]!;
  book = trBook.id;
  chapter = Math.min(Math.max(1, chapter), trBook.chapters.length);

  const parId = options.par ? translationByLinkName(options.par)?.id : settings.parallel;
  const par = parId && parId !== tr.id ? ((await translation(parId)) ?? null) : null;

  state = { tr, par, book, chapter, highlight: new Set(highlight), selected: new Set(), lastClicked: null };
  updateSettings({ lastRead: { book, chapter } });
  render(container);
  updateSelectionBar();

  const first = highlight[0];
  if (first !== undefined) {
    requestAnimationFrame(() => chapterElement?.querySelector(`[data-v="${first}"]`)?.scrollIntoView({ block: 'center' }));
    if (options.notes) {
      const key = toKey(tr, { book, chapter, verse: first });
      if (key) void openVerseComments(tr, key, options.comment);
    }
  } else if (options.scroll !== false) {
    window.scrollTo({ top: 0 });
  }
}

/* ---------------- rendering ---------------- */

function verseNodes(text: string): Node[] {
  if (settings.addedWords === 'plain' || !text.includes('[')) return [document.createTextNode(text)];
  const out: Node[] = [];
  for (const piece of text.split(/(\[[^\]]*\])/)) {
    if (!piece) continue;
    if (piece.startsWith('[') && piece.endsWith(']')) {
      if (settings.addedWords === 'italic') out.push(h('span', { class: 'added' }, piece.slice(1, -1)));
    } else out.push(document.createTextNode(piece));
  }
  return out;
}

function verseElement(tr: Translation, loc: VerseLoc, text: string, own: boolean): HTMLElement {
  const noncanonical = isNoncanonical(tr, loc);
  return h(
    'p',
    {
      class: ['verse', noncanonical && 'noncanonical', own && state?.highlight.has(loc.verse) && 'highlight', own && state?.selected.has(loc.verse) && 'selected'],
      ...textAttrs(tr),
      dataset: own ? { v: String(loc.verse) } : { pv: `${loc.chapter}.${loc.verse}` },
      id: own ? `v${loc.verse}` : undefined,
    },
    h('a', { class: 'vnum', href: own ? formatRoute({ name: 'read', ref: { linkName: tr.linkName, book: loc.book, parts: [{ chapter: loc.chapter, verse: loc.verse }] } }) : undefined, tabindex: own ? undefined : -1 }, loc.chapter !== state?.chapter && !own ? `${loc.chapter}:${loc.verse}` : String(loc.verse)),
    h('span', { class: 'vtext' }, verseNodes(text)),
    own ? h('span', { class: 'markers' }) : null,
  );
}

function title(tr: Translation, book: AnyBookId): string {
  return tr.books.find((b) => b.id === book)?.name ?? bookInfo(book)?.[uiLang()].name ?? book;
}

function render(container: HTMLElement): void {
  if (!state) return;
  const { tr, par, book, chapter } = state;
  const trBook = tr.books.find((b) => b.id === book)!;
  const verses = trBook.chapters[chapter - 1] ?? [];
  root = container;

  const head = h(
    'div',
    { class: 'reader-head' },
    h('button', { type: 'button', class: 'icon-button', 'aria-label': t('reader', 'Previous chapter'), title: t('reader', 'Previous chapter'), on: { click: () => step(-1) } }, icon('left')),
    h('button', { type: 'button', class: 'reader-title', on: { click: () => pickBook() } }, `${title(tr, book)} ${chapter}`, trBook.canonical === false ? h('span', { class: 'badge noncanonical' }, t('reader', 'noncanonical')) : null, icon('down')),
    h('button', { type: 'button', class: 'icon-button', 'aria-label': t('reader', 'Next chapter'), title: t('reader', 'Next chapter'), on: { click: () => step(1) } }, icon('right')),
    h('button', { type: 'button', class: 'translation-pick', title: tr.name, on: { click: (event) => pickTranslation(event.currentTarget as HTMLElement) } }, tr.shortName),
    h('button', { type: 'button', class: ['icon-button', par && 'active'], 'aria-label': t('reader', 'Parallel translation'), title: t('reader', 'Parallel translation'), on: { click: (event) => pickParallel(event.currentTarget as HTMLElement) } }, icon('columns')),
    h('button', { type: 'button', class: ['icon-button', settings.showNotes && 'active'], 'aria-label': t('reader', 'Show comments'), title: t('reader', 'Show comments'), on: { click: () => { updateSettings({ showNotes: !settings.showNotes }); rerender(); } } }, icon('comment')),
  );

  const body = h('div', { class: ['chapter', par && 'parallel'] });
  chapterElement = body;
  if (par) {
    body.appendChild(h('div', { class: 'parallel-head' }, h('span', null, tr.name), h('span', null, par.name)));
    renderParallel(body, tr, par, book, chapter, verses);
  } else {
    let inInsert = false;
    verses.forEach((text, i) => {
      if (!text) return;
      const loc = { book, chapter, verse: i + 1 };
      const nc = trBook.canonical !== false && isNoncanonical(tr, loc);
      if (nc && !inInsert) body.appendChild(h('div', { class: 'nc-label' }, t('reader', 'Noncanonical insertion')));
      inInsert = nc;
      body.appendChild(verseElement(tr, loc, text, true));
    });
  }
  body.addEventListener('click', onVerseClick);

  const prev = neighbour(-1);
  const next = neighbour(1);
  const nav = h(
    'div',
    { class: 'chapter-nav' },
    prev ? h('button', { type: 'button', class: 'button', on: { click: () => step(-1) } }, icon('left'), `${title(tr, prev.book)} ${prev.chapter}`) : h('span'),
    next ? h('button', { type: 'button', class: 'button', on: { click: () => step(1) } }, `${title(tr, next.book)} ${next.chapter}`, icon('right')) : h('span'),
  );

  clear(container, h('div', { class: 'view-scroll' }, head, body, nav), panelElement());
  void fillMarkers();
}

/** Rows aligned by canonical keys; the second translation's verses that map nowhere (insertions) get rows of their own. */
function renderParallel(body: HTMLElement, tr: Translation, par: Translation, book: AnyBookId, chapter: number, verses: string[]): void {
  const used = new Set<string>();
  verses.forEach((text, i) => {
    if (!text) return;
    const loc = { book, chapter, verse: i + 1 };
    const key = toKey(tr, loc);
    const others = key ? fromKey(par, key) : [];
    const right = h('div', { class: 'verse' });
    const cells = others.map((o) => {
      used.add(`${o.chapter}.${o.verse}`);
      return verseElement(par, o, verseText(par, o) ?? '', false);
    });
    body.appendChild(h('div', { class: 'parallel-row' }, verseElement(tr, loc, text, true), cells.length ? h('div', null, cells) : right));
  });
}

function rerender(): void {
  if (root) render(root);
}

/* ---------------- markers ---------------- */

async function fillMarkers(): Promise<void> {
  if (!state || !chapterElement) return;
  const { tr, book, chapter } = state;
  const token = renderToken;
  const keys = new Map<number, ReturnType<typeof toKey>>();
  const count = verseCount(tr, book, chapter);
  for (let verse = 1; verse <= count; verse += 1) keys.set(verse, toKey(tr, { book, chapter, verse }));
  const [comments, tags] = await Promise.all([settings.showNotes ? chapterMarkers(tr, book, chapter, keys) : Promise.resolve(new Map<number, number>()), chapterTags(tr, book, chapter, keys)]);
  if (token !== renderToken || !chapterElement) return;
  for (const element of chapterElement.querySelectorAll<HTMLElement>('.verse[data-v]')) {
    const verse = Number(element.dataset.v);
    const box = element.querySelector('.markers');
    if (!box) continue;
    const key = keys.get(verse);
    box.replaceChildren();
    const n = comments.get(verse);
    if (n && key) {
      box.appendChild(h('button', { type: 'button', class: 'marker', title: t('reader', 'Comments'), on: { click: (e) => { e.stopPropagation(); void openVerseComments(tr, key); } } }, icon('comment'), String(n)));
    }
    const tagCount = tags.get(verse);
    if (tagCount && key) {
      box.appendChild(h('button', { type: 'button', class: 'marker discussion', title: t('reader', 'Discussions'), on: { click: (e) => { e.stopPropagation(); void openVerseDiscussions(tr, key); } } }, icon('scale'), String(tagCount)));
    }
  }
}

export function refreshMarkers(): void {
  void fillMarkers();
}

/* ---------------- selection ---------------- */

function onVerseClick(event: MouseEvent): void {
  if (!state) return;
  const target = event.target as HTMLElement;
  if (target.closest('.marker')) return;
  const element = target.closest<HTMLElement>('.verse[data-v]');
  if (!element) return;
  // Text being selected with the mouse is a selection to copy, not a click.
  if (!target.classList.contains('vnum') && String(getSelection() ?? '').length > 0) return;
  event.preventDefault();
  const verse = Number(element.dataset.v);
  const selected = state.selected;
  if (event.shiftKey && state.lastClicked !== null) {
    const [a, b] = [Math.min(state.lastClicked, verse), Math.max(state.lastClicked, verse)];
    for (let v = a; v <= b; v += 1) selected.add(v);
  } else if (event.metaKey || event.ctrlKey || isTouch() || selected.size) {
    selected.has(verse) ? selected.delete(verse) : selected.add(verse);
  } else {
    selected.clear();
    selected.add(verse);
  }
  state.lastClicked = verse;
  for (const v of chapterElement?.querySelectorAll<HTMLElement>('.verse[data-v]') ?? []) v.classList.toggle('selected', selected.has(Number(v.dataset.v)));
  updateSelectionBar();
}

export function clearSelection(): void {
  if (!state) return;
  state.selected.clear();
  for (const v of chapterElement?.querySelectorAll('.verse.selected') ?? []) v.classList.remove('selected');
  updateSelectionBar();
}

function selectionRef(): ParsedRef | undefined {
  if (!state || !state.selected.size) return undefined;
  return { linkName: state.tr.linkName, book: state.book, parts: partsFromVerses(state.chapter, [...state.selected]) };
}

function selectionRanges(): RefRange[] {
  const ref = selectionRef();
  return ref && state ? refToRanges(state.tr, ref) : [];
}

function selectionCanonical(): boolean {
  if (!state) return false;
  return [...state.selected].every((verse) => toKey(state!.tr, { book: state!.book, chapter: state!.chapter, verse }) !== null);
}

export function pageBase(): string {
  return location.protocol === 'file:' ? location.href.replace(/#.*$/, '') : `${location.origin}${location.pathname}`;
}

export function verseLink(ref: ParsedRef): string {
  return `${pageBase()}#${formatLink(ref)}`;
}

function copyText(ref: ParsedRef): string {
  if (!state) return '';
  const { tr, book, chapter } = state;
  const verses = [...state.selected].sort((a, b) => a - b);
  const lang = (tr.lang === 'ru' ? 'ru' : 'en') as 'ru' | 'en';
  // The translation's own short name: books.ts has no Ukrainian ones.
  const label = `${formatHuman(ref, lang, 'short', tr.lang === 'ru' || tr.lang === 'en' ? undefined : tr.books.find((b) => b.id === book)?.short)}, ${tr.shortName}`;
  const clean = (text: string) => (settings.addedWords === 'hidden' ? text.replace(/\s*\[[^\]]*\]/g, '') : text.replace(/[[\]]/g, ''));
  const texts = verses.map((v) => clean(verseText(tr, { book, chapter, verse: v }) ?? ''));
  let out: string;
  if (settings.copyFormat === 'numbered') out = `${label}\n${verses.map((v, i) => `${v} ${texts[i]}`).join('\n')}`;
  else if (settings.copyFormat === 'ref-first') out = `${label} — ${texts.join(' ')}`;
  else out = `«${texts.join(' ')}» (${label})`;
  if (settings.copyWithLink && location.protocol !== 'file:') out += `\n${verseLink(ref)}`;
  return out;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and file:// pages without permission: a hidden textarea.
    const area = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function updateSelectionBar(): void {
  const bar = document.getElementById('selection-bar');
  if (!bar) return;
  const ref = selectionRef();
  if (!ref || !state) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const canonical = selectionCanonical();
  const lang = uiLang();
  const action = (name: string, label: string, run: () => void) => h('button', { type: 'button', class: 'button', title: label, on: { click: run } }, icon(name), h('span', { class: 'hide-narrow' }, label));
  const buttons: (Node | null)[] = [
    h('span', { class: 'label' }, formatHuman(ref, lang)),
    action('copy', t('selection', 'Copy'), async () => {
      if (await writeClipboard(copyText(ref))) toast(t('selection', 'Copied'));
    }),
    action('link', t('selection', 'Link'), async () => {
      const link = verseLink(ref);
      if (await writeClipboard(link)) {
        toast(location.protocol === 'file:' ? t('selection', 'Link to the file on this computer copied — it will not open for anyone else.') : t('selection', 'Link copied'));
      }
    }),
    'share' in navigator
      ? action('share', t('selection', 'Share'), () => {
          navigator.share({ text: copyText(ref), ...(location.protocol === 'file:' ? {} : { url: verseLink(ref) }) }).catch(() => undefined);
        })
      : null,
    canonical
      ? action('compare', t('selection', 'Compare'), () => {
          const ranges = selectionRanges();
          const first = ranges[0];
          if (!first) return;
          const [fb, fc, fv] = first.from.split('.');
          const last = ranges.at(-1)!;
          const [, lc, lv] = last.to.split('.');
          const part = fc === lc ? { chapter: Number(fc), verse: Number(fv), ...(fv !== lv ? { endVerse: Number(lv) } : {}) } : { chapter: Number(fc), verse: Number(fv), endChapter: Number(lc), endVerse: Number(lv) };
          location.hash = formatRoute({ name: 'compare', ref: { book: fb as BookId, parts: [part] } });
        })
      : null,
    canonical
      ? action('comment', t('selection', 'Comment'), () => {
          const ranges = selectionRanges();
          if (ranges[0] && state) openCommentEditor(state.tr, { from: ranges[0].from, to: ranges.at(-1)!.to });
        })
      : null,
    canonical ? action('scale', t('selection', 'Discuss'), () => addToDiscussion(selectionRanges())) : null,
    h('button', { type: 'button', class: 'icon-button', 'aria-label': t('selection', 'Clear selection'), on: { click: clearSelection } }, icon('close')),
  ];
  bar.replaceChildren(...buttons.filter((b): b is Node => b !== null));
  bar.hidden = false;
}

/* ---------------- navigation ---------------- */

function neighbour(direction: 1 | -1): { book: AnyBookId; chapter: number } | undefined {
  if (!state) return undefined;
  const { tr, book, chapter } = state;
  const books = visibleBooks(tr);
  const index = books.findIndex((b) => b.id === book);
  const current = tr.books.find((b) => b.id === book)!;
  if (direction === 1) {
    if (chapter < current.chapters.length) return { book, chapter: chapter + 1 };
    const next = books[index + 1];
    return next ? { book: next.id, chapter: 1 } : undefined;
  }
  if (chapter > 1) return { book, chapter: chapter - 1 };
  const prev = books[index - 1];
  return prev ? { book: prev.id, chapter: prev.chapters.length } : undefined;
}

function visibleBooks(tr: Translation) {
  return tr.books.filter((b) => !(settings.hideNoncanonicalBooks && b.canonical === false) || b.id === state?.book);
}

export function step(direction: 1 | -1): void {
  const target = neighbour(direction);
  if (!target || !state) return;
  goTo(target.book, target.chapter);
}

function goTo(book: AnyBookId, chapter: number): void {
  if (!state) return;
  closePanel();
  location.hash = formatRoute({ name: 'read', ref: { linkName: state.tr.linkName, book, parts: [{ chapter }] } });
}

function pickBook(): void {
  if (!state) return;
  const { tr, book: currentBook, chapter: currentChapter } = state;
  const body = h('div');
  const showBooks = () => {
    const groups: [string, typeof tr.books][] = [
      [t('picker', 'Old Testament'), visibleBooks(tr).filter((b) => bookInfo(b.id)?.testament === 'OT')],
      [t('picker', 'New Testament'), visibleBooks(tr).filter((b) => bookInfo(b.id)?.testament === 'NT')],
    ];
    clear(
      body,
      // A New Testament alone (the Greek) has no Old Testament to title.
      groups.filter(([, books]) => books.length).map(([name, books]) => [
        h('div', { class: 'group-title' }, name),
        h(
          'div',
          { class: 'book-grid' },
          books.map((b) =>
            h('button', { type: 'button', class: [b.id === currentBook && 'current', b.canonical === false && 'noncanonical'], title: b.canonical === false ? t('reader', 'noncanonical') : b.name, on: { click: () => (b.chapters.length === 1 ? choose(b.id, 1) : showChapters(b.id)) } }, b.name),
          ),
        ),
      ]),
    );
  };
  const showChapters = (id: AnyBookId) => {
    const b = tr.books.find((x) => x.id === id)!;
    clear(
      body,
      h('button', { type: 'button', class: 'button ghost small', on: { click: showBooks } }, icon('left'), t('picker', 'Books')),
      h('div', { class: 'group-title' }, b.name),
      h('div', { class: 'chapter-grid' }, b.chapters.map((_, i) => h('button', { type: 'button', class: id === currentBook && i + 1 === currentChapter ? 'current' : undefined, on: { click: () => choose(id, i + 1) } }, String(i + 1)))),
    );
  };
  const choose = (id: AnyBookId, chapter: number) => {
    handle.close();
    goTo(id, chapter);
  };
  const handle = dialog({ title: t('picker', 'Go to'), body, wide: true });
  showBooks();
}

function pickTranslation(anchor: HTMLElement): void {
  const items = installedPacks('translation').map((p) => ({
    label: `${p.shortName ?? ''} — ${p.name}`,
    icon: p.id === state?.tr.id ? 'check' : undefined,
    action: () => switchTranslation(p.id),
  }));
  menu(anchor, [...items, 'separator', { label: t('reader', 'Translations and commentaries…'), icon: 'download', action: () => (location.hash = '#/settings') }]);
}

function pickParallel(anchor: HTMLElement): void {
  const items = installedPacks('translation')
    .filter((p) => p.id !== state?.tr.id)
    .map((p) => ({ label: `${p.shortName ?? ''} — ${p.name}`, icon: p.id === state?.par?.id ? 'check' : undefined, action: () => setParallel(p.id) }));
  menu(anchor, [{ label: t('reader', 'No parallel translation'), icon: state?.par ? undefined : 'check', action: () => setParallel(null) }, ...(items.length ? ['separator' as const, ...items] : [])]);
}

async function setParallel(id: string | null): Promise<void> {
  updateSettings({ parallel: id });
  if (!state) return;
  state.par = id ? ((await translation(id)) ?? null) : null;
  rerender();
}

async function switchTranslation(id: string): Promise<void> {
  if (!state) return;
  const target = await translation(id);
  if (!target) return;
  // Same place in the other numbering: through the canonical key of the first verse.
  const key = toKey(state.tr, { book: state.book, chapter: state.chapter, verse: [...state.highlight][0] ?? 1 });
  const native = key ? fromKey(target, key)[0] : undefined;
  updateSettings({ translation: id });
  const book = native?.book ?? (target.books.some((b) => b.id === state!.book) ? state.book : target.books[0]!.id);
  const chapter = native?.chapter ?? state.chapter;
  location.hash = formatRoute({ name: 'read', ref: { linkName: target.linkName, book, parts: [{ chapter }] } });
}

export { keyOf };
