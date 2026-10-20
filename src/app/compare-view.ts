/**
 * One passage in every installed translation. The address is in canonical
 * numbering (#/compare/Psa23-1); each translation shows its own verses for
 * it, and its own numbers when they differ («Пс 23:1 [SYN: Пс 22:2]»).
 * Noncanonical texts never take part.
 */

import { type BookId, isCanonicalBook } from '../core/books';
import { canonicalVerseCount, fromKey, textAttrs, verseText } from '../core/canon';
import { t } from '../core/i18n';
import { formatHuman, type ParsedRef } from '../core/refs';
import { formatRoute } from '../core/route';
import type { Translation, VerseLoc } from '../core/types';
import { clear, h, icon } from './dom';
import { installedPacks, translation } from './packs';
import { settings, uiLang, updateSettings } from './state';
import { toast } from './ui';

/** Canonical verses of a reference, in order. */
function canonicalVerses(ref: ParsedRef): { book: BookId; chapter: number; verse: number }[] {
  const book = ref.book as BookId;
  const out: { book: BookId; chapter: number; verse: number }[] = [];
  for (const part of ref.parts) {
    const endChapter = part.endChapter ?? part.chapter;
    for (let chapter = part.chapter; chapter <= endChapter; chapter += 1) {
      const count = canonicalVerseCount(book, chapter);
      const from = chapter === part.chapter ? (part.verse ?? 1) : 1;
      const to = chapter === endChapter ? (part.endVerse ?? part.verse ?? count) : count;
      for (let verse = from; verse <= Math.min(to, count); verse += 1) out.push({ book, chapter, verse });
    }
  }
  return out.slice(0, 60);
}

export async function openCompare(container: HTMLElement, ref: ParsedRef): Promise<void> {
  const page = h('div', { class: 'page' });
  clear(container, h('div', { class: 'view-scroll' }, page));
  if (!isCanonicalBook(ref.book)) {
    page.appendChild(h('div', { class: 'empty' }, t('compare', 'Noncanonical books are not compared.')));
    return;
  }
  const keys = canonicalVerses(ref);
  page.appendChild(h('h1', null, t('compare', 'Compare: {ref}', { ref: formatHuman(ref, uiLang(), 'name') })));

  const order = settings.compareOrder;
  const packs = installedPacks('translation')
    .filter((p) => !settings.compareHidden.includes(p.id))
    .sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
  const all: string[] = [];
  for (const pack of packs) {
    const tr = await translation(pack.id);
    if (!tr) continue;
    const verses: { key: (typeof keys)[number]; native: VerseLoc[] }[] = keys.map((key) => ({ key, native: fromKey(tr, key) }));
    type Line = { loc: VerseLoc | null; key: (typeof keys)[number]; text: string };
    const lines = verses.flatMap(({ key, native }): Line[] =>
      native.length ? native.map((loc) => ({ loc, key, text: (verseText(tr, loc) ?? '').replace(/[[\]]/g, '') })) : [{ loc: null, key, text: '' }],
    );
    const firstNative = lines.find((l) => l.loc)?.loc;
    const differs = lines.some((l) => l.loc && (l.loc.chapter !== l.key.chapter || l.loc.verse !== l.key.verse));
    const own = firstNative && differs ? ` [${tr.shortName}: ${formatHuman({ book: firstNative.book, parts: [{ chapter: firstNative.chapter, verse: firstNative.verse }] }, uiLang())}]` : '';
    all.push(`${tr.shortName}: ${lines.map((l) => l.text).join(' ')}`);
    page.appendChild(
      h(
        'section',
        { class: 'compare-card' },
        h(
          'h3',
          null,
          h('span', null, `${tr.shortName} · ${tr.name}`),
          own ? h('span', { class: 'badge' }, own.trim()) : null,
          h('span', { class: 'spacer' }),
          firstNative
            ? h('a', { class: 'button ghost small', href: formatRoute({ name: 'read', ref: { linkName: tr.linkName, book: firstNative.book, parts: [{ chapter: firstNative.chapter, verse: firstNative.verse }] } }) }, t('compare', 'Open'))
            : null,
          h('button', { type: 'button', class: 'icon-button', title: t('compare', 'Hide this translation here'), 'aria-label': t('compare', 'Hide this translation here'), on: { click: () => { updateSettings({ compareHidden: [...settings.compareHidden, tr.id] }); void openCompare(container, ref); } } }, icon('close')),
        ),
        lines.map((l) => (l.loc ? h('p', textAttrs(tr), h('sup', null, keys.length > 1 || differs ? `${l.loc.chapter}:${l.loc.verse}` : ''), l.text) : h('p', { class: 'missing' }, t('compare', 'Not in this translation ({ref}).', { ref: `${l.key.chapter}:${l.key.verse}` })))),
      ),
    );
    void (tr satisfies Translation);
  }
  const hidden = settings.compareHidden.filter((id) => installedPacks('translation').some((p) => p.id === id));
  page.appendChild(
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'button', on: { click: async () => { await navigator.clipboard.writeText(`${formatHuman(ref, uiLang())}\n${all.join('\n')}`); toast(t('selection', 'Copied')); } } }, icon('copy'), t('compare', 'Copy all')),
      hidden.length ? h('button', { type: 'button', class: 'button ghost', on: { click: () => { updateSettings({ compareHidden: [] }); void openCompare(container, ref); } } }, t('compare', 'Show hidden translations ({count})', { count: hidden.length })) : null,
    ),
  );
  if (packs.length < 2) page.appendChild(h('p', { class: 'hint' }, t('compare', 'Download more translations to compare them: menu → Translations and commentaries.')));
}
