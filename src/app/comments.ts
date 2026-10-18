/**
 * Comments on verses — all offline: the user's own (IndexedDB) and installed
 * commentaries (Lopukhin, files people share). Shown as 💬 markers in the
 * chapter and in the side panel; written in the Markdown editor.
 */

import { isCanonicalBook, type BookId } from '../core/books';
import { type CanonVerse, canonicalRefToNative, compareKeys, parseKey, parseRange, rangeContains, rangeToNative, schemeRefToCanonical, verseText } from '../core/canon';
import { t, tn } from '../core/i18n';
import type { Inline } from '../core/markdown';
import { formatHuman, partsFromVerses } from '../core/refs';
import type { CommentaryEntry, MyComment, RefRange, Translation } from '../core/types';
import { h, icon } from './dom';
import { editor } from './editor';
import { commentsForBook, deleteComment, saveComment } from './my-comments';
import { closePanel, openPanel } from './panel';
import { commentaryBook, installedPacks } from './packs';
import { refreshMarkers } from './reader';
import { renderMarkdown } from './render-md';
import { settings, uiLang } from './state';
import { confirmDialog, dialog, toast } from './ui';

interface Source {
  id: string;
  name: string;
  own: boolean;
  /** Numbering of the references inside the entries' text. */
  versification?: string;
  entries: { range: RefRange; md: string; mine?: MyComment }[];
}

async function sources(book: BookId): Promise<Source[]> {
  const mine = await commentsForBook(book);
  const out: Source[] = [{ id: 'mine', name: t('comments', 'My comments'), own: true, entries: mine.map((c) => ({ range: c.ref, md: c.bodyMd, mine: c })) }];
  const packs = installedPacks('commentary').filter((p) => !settings.hiddenCommentaries.includes(p.id));
  const books = await Promise.all(packs.map((p) => commentaryBook(p.id, book)));
  packs.forEach((pack, i) => {
    const entries = (books[i] ?? [])
      .map((e: CommentaryEntry) => ({ range: parseRange(e.ref), md: e.md }))
      .filter((e): e is { range: RefRange; md: string } => !!e.range);
    out.push({ id: pack.id, name: pack.name, own: false, entries, ...(pack.versification ? { versification: pack.versification } : {}) });
  });
  return out;
}

/** Comment counts per verse of a chapter: each comment counts at the first verse of its range that is in the chapter. */
export async function chapterMarkers(tr: Translation, book: string, chapter: number, keys: Map<number, CanonVerse | null>): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  const canonBooks = new Set<BookId>();
  for (const key of keys.values()) if (key) canonBooks.add(key.book);
  if (!canonBooks.size && isCanonicalBook(book)) canonBooks.add(book);
  const ordered = [...keys.entries()].filter((e): e is [number, CanonVerse] => !!e[1]);
  for (const canonBook of canonBooks) {
    for (const source of await sources(canonBook)) {
      for (const entry of source.entries) {
        const hit = ordered.find(([, key]) => rangeContains(entry.range, key));
        if (hit) counts.set(hit[0], (counts.get(hit[0]) ?? 0) + 1);
      }
    }
  }
  void tr;
  void chapter;
  return counts;
}

/** The verse's text, for a reference's tooltip in a comment. */
export function refTitleFor(tr: Translation) {
  return (node: Extract<Inline, { t: 'ref' }>): string | undefined => {
    const native = node.ref.linkName ? node.ref : canonicalRefToNative(tr, node.ref);
    const part = native?.parts[0];
    if (!native || !part) return undefined;
    const text = verseText(tr, { book: native.book, chapter: part.chapter, verse: part.verse ?? 1 });
    return text ? `${formatHuman(native, uiLang())}: ${text.replace(/[[\]]/g, '')}` : undefined;
  };
}

/** A canonical range, written for people in the translation's numbering. */
function rangeLabel(tr: Translation, range: RefRange): string {
  const verses = rangeToNative(tr, range);
  const first = verses[0];
  if (!first) return range.from;
  const sameChapter = verses.filter((v) => v.chapter === first.chapter && v.book === first.book);
  const last = verses.at(-1)!;
  if (last.chapter !== first.chapter) {
    return formatHuman({ book: first.book, parts: [{ chapter: first.chapter, verse: first.verse, endChapter: last.chapter, endVerse: last.verse }] }, uiLang());
  }
  return formatHuman({ book: first.book, parts: partsFromVerses(first.chapter, sameChapter.map((v) => v.verse)) }, uiLang());
}

function commentCard(tr: Translation, entry: Source['entries'][number], source: Source, focus: boolean, key: CanonVerse): HTMLElement {
  const scheme = source.versification;
  const body = renderMarkdown(entry.md, refTitleFor(tr), scheme && scheme !== 'kjv' ? (ref) => schemeRefToCanonical(scheme, ref) : undefined);
  const card = h(
    'article',
    { class: 'comment', id: entry.mine ? `c-${entry.mine.id}` : undefined },
    h(
      'div',
      { class: 'comment-ref' },
      rangeLabel(tr, entry.range),
      h('span', { class: 'spacer' }),
      entry.mine
        ? [
            h('button', { type: 'button', class: 'icon-button', title: t('comments', 'Edit'), 'aria-label': t('comments', 'Edit'), on: { click: () => openCommentEditor(tr, entry.range, entry.mine) } }, icon('edit')),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-button',
                title: t('comments', 'Delete'),
                'aria-label': t('comments', 'Delete'),
                on: {
                  click: async () => {
                    if (!(await confirmDialog(t('comments', 'Delete the comment?'), t('comments', 'It is only on this device; it cannot be brought back.'), t('comments', 'Delete'), true))) return;
                    await deleteComment(entry.mine!.id);
                    refreshMarkers();
                    void openVerseComments(tr, key);
                  },
                },
              },
              icon('trash'),
            ),
          ]
        : null,
    ),
    body,
  );
  if (!focus && entry.md.length > 700) {
    card.classList.add('collapsed');
    card.appendChild(h('button', { type: 'button', class: 'more-link', on: { click: (e) => { card.classList.remove('collapsed'); (e.currentTarget as HTMLElement).remove(); } } }, t('comments', 'Show all')));
  }
  return card;
}

export async function openVerseComments(tr: Translation, key: CanonVerse, focusId?: string): Promise<void> {
  const all = await sources(key.book);
  const native = rangeToNative(tr, { from: `${key.book}.${key.chapter}.${key.verse}` as RefRange['from'], to: `${key.book}.${key.chapter}.${key.verse}` as RefRange['to'] })[0];
  const label = native ? formatHuman({ book: native.book, parts: [{ chapter: native.chapter, verse: native.verse }] }, uiLang()) : '';
  const range: RefRange = { from: `${key.book}.${key.chapter}.${key.verse}` as RefRange['from'], to: `${key.book}.${key.chapter}.${key.verse}` as RefRange['to'] };
  const groups = all
    .map((source) => ({ source, entries: source.entries.filter((e) => rangeContains(e.range, key)).sort((a, b) => compareKeys(parseKey(a.range.from)!, parseKey(b.range.from)!)) }))
    .filter((g) => g.entries.length || g.source.own);
  const body = h(
    'div',
    null,
    groups.map(({ source, entries }) =>
      h(
        'section',
        { class: 'panel-group' },
        h('h3', null, source.name, h('span', { class: 'badge' }, String(entries.length))),
        entries.map((entry) => commentCard(tr, entry, source, !!focusId && entry.mine?.id === focusId, key)),
        source.own ? h('button', { type: 'button', class: 'button small', on: { click: () => openCommentEditor(tr, range) } }, icon('plus'), t('comments', 'Add a comment')) : null,
      ),
    ),
    groups.length === 1 && !groups[0]!.entries.length && !installedPacks('commentary').length ? h('p', { class: 'hint' }, t('comments', 'Commentaries can be downloaded in the menu: Translations and commentaries.')) : null,
  );
  openPanel(t('comments', 'Comments · {verse}', { verse: label }), body);
  if (focusId) requestAnimationFrame(() => document.getElementById(`c-${focusId}`)?.scrollIntoView({ block: 'start' }));
}

export function openCommentEditor(tr: Translation, range: RefRange, existing?: MyComment): void {
  const ed = editor(existing?.bodyMd ?? '', { placeholder: t('comments', 'Your comment. **bold**, *italic*, [link](https://…)'), refTitle: refTitleFor(tr) });
  const save = async () => {
    const value = ed.value();
    const problem = ed.problem();
    if (problem) return toast(problem, 'error');
    if (!value) return toast(t('comments', 'The comment is empty.'), 'error');
    const saved = await saveComment({ id: existing?.id, ref: range, bodyMd: value });
    handle.close();
    toast(t('comments', 'Saved on this device'));
    refreshMarkers();
    const key = parseKey(saved.ref.from);
    if (key) void openVerseComments(tr, key, saved.id);
  };
  const handle = dialog({
    title: existing ? t('comments', 'Edit the comment · {verse}', { verse: rangeLabel(tr, range) }) : t('comments', 'Comment · {verse}', { verse: rangeLabel(tr, range) }),
    body: h('div', null, ed.element, h('p', { class: 'hint' }, t('comments', 'Kept only on this device. Export your comments to a file in the menu.'))),
    wide: true,
    actions: [
      h('button', { type: 'button', class: 'button', on: { click: () => handle.close() } }, t('dialog', 'Cancel')),
      h('button', { type: 'button', class: 'button primary', on: { click: save } }, t('comments', 'Save')),
    ],
  });
  ed.focus();
}

export function commentCountLabel(n: number): string {
  return tn('comments', '{count} comment', '{count} comments', n);
}

export { closePanel };
