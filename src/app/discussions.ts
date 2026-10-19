/**
 * The Discussions tab and its traces in the reader.
 *
 * A topic has subtopics; a subtopic has verses — the "stones" on the scales.
 * A verse is shared by both sides: anyone adds it, and everyone votes on what
 * it teaches — the first position, the second, or nothing on the subject. One
 * verse is one point; the subtopic and the topic are decided by the sum. Each
 * side explains a verse in its own column of interpretations.
 *
 * Two ratings stand side by side and never mix: the users' votes and the AI's
 * (models re-evaluate a verse by themselves after a verse or an interpretation
 * is added). Everyone reads and writes in their own language; the server
 * translates.
 *
 * In the reader, a verse used in a discussion gets a ⚖ marker; its panel lists
 * the discussions with the verse's result and leads to it.
 */

import { type Argument, type ArgumentVerse, type Interpretation, localized, type LocalizedText, type Outcome, type Question, type QuestionFull, type Tallies, type Tally, type VerseTag, type VoteValue } from '../core/api-types';
import { bookInfo, type BookId } from '../core/books';
import { type CanonVerse, compareKeys, keyOf, parseKey, rangeToNative, refToRanges, verseText } from '../core/canon';
import { CONFIG } from '../core/config';
import { discussionFile, discussionFileName } from '../core/discussion-file';
import { t, tn } from '../core/i18n';
import { formatHuman, parseRefs, partsFromVerses } from '../core/refs';
import { tallyLean, tilt } from '../core/rating';
import { formatRoute } from '../core/route';
import type { RefRange, Translation } from '../core/types';
import { api, ApiError, serverUp } from './api';
import { authAvailable, currentUser, signInDialog } from './auth-service';
import { get, put } from './db';
import { clear, h, icon } from './dom';
import { editor } from './editor';
import { download } from './my-comments';
import { openPanel } from './panel';
import { personLink, when } from './people';
import { installedPacks, packMeta, translation, translationNow } from './packs';
import { readerState, refreshMarkers } from './reader';
import { renderMarkdown } from './render-md';
import { settings, uiLang } from './state';
import { anyDialogOpen, confirmDialog, dialog, toast } from './ui';

const text = (value: LocalizedText | undefined) => localized(value, uiLang());

function localizedNodes(value: LocalizedText | undefined, markdown = false): Node[] {
  const { text: shown, translated } = text(value);
  const body = markdown ? renderMarkdown(shown) : document.createTextNode(shown);
  if (!translated || !value) return [body];
  const original = value[value.orig] ?? '';
  const note = h('button', { type: 'button', class: 'translated more-link' }, t('discussions', 'Translated automatically · show the original'));
  let showingOriginal = false;
  const holder = h('span', null, body);
  note.addEventListener('click', () => {
    showingOriginal = !showingOriginal;
    holder.replaceChildren(markdown ? renderMarkdown(showingOriginal ? original : shown) : document.createTextNode(showingOriginal ? original : shown));
    note.textContent = showingOriginal ? t('discussions', 'Show the translation') : t('discussions', 'Translated automatically · show the original');
  });
  return [holder, h('div', null, note)];
}

/** What a verse's result is called: a position's own label, "not relevant" or "undecided". */
function outcomeLabel(outcome: Outcome | undefined, sides: { pro: LocalizedText; con: LocalizedText } | undefined): string {
  if (outcome === 1) return sides ? text(sides.pro).text : t('discussions', 'For');
  if (outcome === -1) return sides ? text(sides.con).text : t('discussions', 'Against');
  if (outcome === 0) return t('discussions', 'Not relevant');
  return t('discussions', 'Undecided');
}

const outcomeClass = (outcome: Outcome | undefined) => (outcome === 1 ? 'pro' : outcome === -1 ? 'con' : outcome === 0 ? 'none' : 'open');

function currentTranslationId(): string | undefined {
  return settings.translation && packMeta(settings.translation) ? settings.translation : installedPacks('translation')[0]?.id;
}

function readerTranslation(): Translation | undefined {
  const id = currentTranslationId();
  return readerState()?.tr ?? (id ? translationNow(id) : undefined);
}

/**
 * The verses' text comes from the translation being read. Opened straight from
 * a link, the page has not loaded it yet: load it before drawing.
 */
async function loadTranslation(): Promise<void> {
  const id = currentTranslationId();
  if (!readerTranslation() && id) await translation(id);
}

/** «Ин 1:1–3» in the reader's translation (its own numbering). */
function rangeLabel(range: RefRange, tr = readerTranslation()): string {
  const from = parseKey(range.from);
  const verses = tr ? rangeToNative(tr, range) : [];
  const first = verses[0];
  if (!first) return from ? `${bookInfo(from.book)?.[uiLang()].short ?? from.book} ${from.chapter}:${from.verse}` : range.from;
  const last = verses.at(-1)!;
  const parts = last.chapter === first.chapter ? partsFromVerses(first.chapter, verses.map((v) => v.verse)) : [{ chapter: first.chapter, verse: first.verse, endChapter: last.chapter, endVerse: last.verse }];
  return formatHuman({ book: first.book, parts }, uiLang());
}

/* ---------------- verse tags (reader) ---------------- */

const tagCache = new Map<string, { at: number; tags: VerseTag[] }>();

/** Tags of one canonical chapter: from the server, else the last copy kept offline. */
async function tagsOf(book: BookId, chapter: number): Promise<{ tags: VerseTag[]; stale: boolean }> {
  const id = `${book}.${chapter}`;
  const memory = tagCache.get(id);
  if (memory && Date.now() - memory.at < 60_000) return { tags: memory.tags, stale: false };
  if (await serverUp()) {
    try {
      const tags = await api.verseTags(book, chapter, uiLang());
      tagCache.set(id, { at: Date.now(), tags });
      void put('cache', { at: Date.now(), tags }, `tags:${id}`).catch(() => undefined);
      return { tags, stale: false };
    } catch {
      // Fall through to the copy kept offline.
    }
  }
  const kept = await get<{ at: number; tags: VerseTag[] }>('cache', `tags:${id}`).catch(() => undefined);
  return { tags: kept?.tags ?? [], stale: !!kept };
}

export async function chapterTags(_tr: Translation, _book: string, _chapter: number, keys: Map<number, CanonVerse | null>): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (!authAvailable()) return counts;
  const chapters = new Map<string, { book: BookId; chapter: number }>();
  for (const key of keys.values()) if (key) chapters.set(`${key.book}.${key.chapter}`, { book: key.book, chapter: key.chapter });
  const all: VerseTag[] = [];
  for (const { book, chapter } of chapters.values()) all.push(...(await tagsOf(book, chapter)).tags);
  if (!all.length) return counts;
  for (const [verse, key] of keys) {
    if (!key) continue;
    const id = keyOf(key);
    const questions = new Set(all.filter((tag) => tag.key === id).map((tag) => tag.questionId));
    if (questions.size) counts.set(verse, questions.size);
  }
  return counts;
}

export async function openVerseDiscussions(tr: Translation, key: CanonVerse): Promise<void> {
  const { tags, stale } = await tagsOf(key.book, key.chapter);
  const id = keyOf(key);
  const mine = tags.filter((tag) => tag.key === id);
  const label = rangeLabel({ from: id, to: id }, tr);
  const result = (name: string, outcome: Outcome) => h('span', { class: ['outcome', outcomeClass(outcome)] }, `${name}: ${outcomeLabel(outcome, undefined)}`);
  const body = h(
    'div',
    null,
    stale ? h('p', { class: 'stale' }, t('discussions', 'No connection: the list may be out of date.')) : null,
    mine.length
      ? mine.map((tag) =>
          h(
            'a',
            { class: 'tag-item', href: formatRoute({ name: 'discussion', id: tag.questionId, verse: tag.verseId }) },
            h('div', { class: 'title' }, text(tag.questionTitle).text),
            tag.argumentTitle ? h('div', { class: 'where' }, text(tag.argumentTitle).text) : null,
            h('div', { class: 'outcomes' }, result(t('discussions', 'Users'), tag.users), result(t('discussions', 'AI'), tag.ai)),
          ),
        )
      : h('p', { class: 'hint' }, t('discussions', 'This verse is not used in any discussion yet.')),
    h('button', { type: 'button', class: 'button small', on: { click: () => addToDiscussion([{ from: id, to: id }]) } }, icon('plus'), t('discussions', 'Use this verse in a discussion')),
  );
  openPanel(t('discussions', 'Discussions · {verse}', { verse: label }), body);
}

/* ---------------- shared pieces ---------------- */

function requireSignIn(): boolean {
  if (currentUser()) return true;
  signInDialog();
  return false;
}


function scaleSvg(lean: number | null): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const make = (tag: string, attrs: Record<string, string>) => {
    const element = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) element.setAttribute(k, v);
    return element;
  };
  // The pivot sits low enough that the raised end, 72 × sin(MAX_TILT) ≈ 25 above
  // it at full tilt, stays inside the picture; the lowered pan hangs 52 below its end.
  const Y = 32;
  const svg = make('svg', { viewBox: '0 0 200 124', role: 'img' }) as SVGSVGElement;
  // The beam tips toward the heavier pan: the first position on the left goes down when lean > 0.
  const angle = -tilt(lean);
  svg.appendChild(make('path', { d: `M100 ${Y} L100 114 M70 114 H130`, stroke: 'currentColor', 'stroke-width': '3', fill: 'none', opacity: '0.5' }));
  const beam = make('g', { transform: `rotate(${angle} 100 ${Y})` });
  beam.appendChild(make('path', { d: `M28 ${Y} H172`, stroke: 'currentColor', 'stroke-width': '3', 'stroke-linecap': 'round' }));
  const pan = (x: number, color: string) => {
    const g = make('g', { transform: `rotate(${-angle} ${x} ${Y})` });
    g.appendChild(make('path', { d: `M${x} ${Y} L${x - 18} ${Y + 36} M${x} ${Y} L${x + 18} ${Y + 36}`, stroke: 'currentColor', 'stroke-width': '1.2', opacity: '0.6' }));
    g.appendChild(make('path', { d: `M${x - 22} ${Y + 36} Q${x} ${Y + 52} ${x + 22} ${Y + 36} Z`, fill: color }));
    return g;
  };
  beam.appendChild(pan(28, 'var(--pro)'));
  beam.appendChild(pan(172, 'var(--con)'));
  svg.appendChild(beam);
  svg.appendChild(make('circle', { cx: '100', cy: String(Y), r: '4', fill: 'currentColor' }));
  return svg;
}

const EMPTY: Tally = { pro: 0, con: 0, none: 0, open: 0 };

/** The verdict in one word: the label of the position with more points, "equal" or "no points yet". */
function verdict(tally: Tally, sides: { pro: LocalizedText; con: LocalizedText }): { word: string; cls: 'pro' | 'con' | 'even' | 'none' } {
  if (tally.pro > tally.con) return { word: text(sides.pro).text, cls: 'pro' };
  if (tally.con > tally.pro) return { word: text(sides.con).text, cls: 'con' };
  return tally.pro ? { word: t('discussions', 'Equal'), cls: 'even' } : { word: t('discussions', 'No points yet'), cls: 'none' };
}

/** The big scales of a topic: the beam, the verdict in large coloured letters, the score under it. */
function scaleCard(label: string, tally: Tally | undefined, sides: { pro: LocalizedText; con: LocalizedText }, pending = false): HTMLElement {
  const score = tally ?? EMPTY;
  const lean = tallyLean(score);
  const result = verdict(score, sides);
  const extra = [score.none ? t('discussions', 'not relevant: {count}', { count: score.none }) : '', score.open ? t('discussions', 'undecided: {count}', { count: score.open }) : ''].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'scale-card' },
    h('h3', null, label),
    scaleSvg(lean),
    h('div', { class: ['verdict-word', result.cls] }, result.word),
    h('div', { class: 'value' }, h('span', { class: 'pro-score' }, String(score.pro)), ' : ', h('span', { class: 'con-score' }, String(score.con))),
    h('div', { class: 'sub' }, pending ? h('span', { class: 'pending' }, t('discussions', 'AI is re-evaluating…')) : extra || ' '),
  );
}

/** A small score: "AI 5 : 2". */
function miniScore(label: string, tally: Tally | undefined, pending = false): HTMLElement {
  const score = tally ?? EMPTY;
  return h(
    'span',
    { class: 'mini-score', title: `${label}: ${score.pro} : ${score.con}` },
    label,
    ' ',
    pending ? h('span', { class: 'pending' }) : null,
    h('b', { class: 'pro-score' }, String(score.pro)),
    ':',
    h('b', { class: 'con-score' }, String(score.con)),
  );
}

/* ---------------- the list ---------------- */

export async function openDiscussions(container: HTMLElement, tag?: string): Promise<void> {
  const page = h('div', { class: 'page' });
  clear(container, h('div', { class: 'view-scroll' }, page));
  page.appendChild(
    h(
      'div',
      { class: 'row' },
      h('h1', { class: 'grow' }, t('discussions', 'Discussions')),
      h('button', { type: 'button', class: 'button primary', on: { click: () => newQuestion() } }, icon('plus'), t('discussions', 'New topic')),
    ),
  );
  if (!(await serverUp())) {
    page.appendChild(h('div', { class: 'empty' }, authAvailable() ? t('discussions', 'No connection to the server. Discussions need the internet.') : t('discussions', 'Discussions are not available in this build.')));
    return;
  }
  let questions: Question[];
  try {
    questions = await api.questions(uiLang(), tag);
  } catch (error) {
    page.appendChild(h('div', { class: 'empty' }, (error as Error).message));
    return;
  }
  if (tag) page.appendChild(h('p', null, h('span', { class: 'chip' }, `#${tag}`), ' ', h('a', { href: '#/discussions' }, t('discussions', 'All topics'))));
  if (!questions.length) page.appendChild(h('div', { class: 'empty' }, t('discussions', 'No topics yet. Start the first one.')));
  for (const q of questions.filter((x) => !x.deleted)) {
    page.appendChild(
      h(
        'a',
        { class: 'q-card', href: formatRoute({ name: 'discussion', id: q.id }) },
        h('h3', null, text(q.title).text),
        // Plain text here: the card is a link already.
        h('div', { class: 'meta byline' }, q.author?.displayName ?? '', ' · ', when(q.createdAt)),
        h(
          'div',
          { class: 'meta' },
          miniScore(t('discussions', 'Users'), q.tally?.users),
          miniScore(t('discussions', 'AI'), q.tally?.ai, q.tally?.aiStatus === 'pending'),
          q.argumentCount !== undefined ? tn('discussions', '{count} subtopic', '{count} subtopics', q.argumentCount) : null,
          q.verseCount !== undefined ? tn('discussions', '{count} verse', '{count} verses', q.verseCount) : null,
          q.tags.map((x) => h('span', { class: 'badge' }, `#${x}`)),
        ),
        h('div', { class: 'meta sides-line' }, h('span', { class: 'side-dot pro' }), text(q.sides.pro).text, h('span', { class: 'side-dot con' }), text(q.sides.con).text),
      ),
    );
  }
}

/* ---------------- a topic ---------------- */

let polling: number | undefined;
/** Subtopics the reader opened, kept across the redraws a vote or a poll makes. */
const openArguments = new Set<string>();

interface Focus {
  argument?: string;
  verse?: string;
}

export async function openDiscussion(container: HTMLElement, id: string, focus: Focus = {}, keepScroll = false): Promise<void> {
  clearTimeout(polling);
  const scroll = window.scrollY;
  await loadTranslation();
  let data: QuestionFull;
  if (!(await serverUp())) {
    clear(container, h('div', { class: 'view-scroll' }, h('div', { class: 'page' }, h('div', { class: 'empty' }, t('discussions', 'No connection to the server. Discussions need the internet.')))));
    return;
  }
  try {
    data = await api.question(id, uiLang());
  } catch (error) {
    clear(container, h('div', { class: 'view-scroll' }, h('div', { class: 'page' }, h('div', { class: 'empty' }, (error as Error).message))));
    return;
  }
  const page = h('div', { class: 'page wide' });
  clear(container, h('div', { class: 'view-scroll' }, page));
  const reload = () => void openDiscussion(container, id, {}, true);
  renderQuestion(page, data, focus, reload);
  if (keepScroll) window.scrollTo({ top: scroll });
  if (data.verses.some((v) => v.ai?.status === 'pending')) {
    // The models re-evaluate in the background: look again until they are done.
    polling = window.setTimeout(() => {
      if (location.hash.startsWith(`#/discussions/${id}`) && !anyDialogOpen()) reload();
    }, 3000);
  }
}

function byBibleOrder(a: ArgumentVerse, b: ArgumentVerse): number {
  const [af, bf] = [parseKey(a.ref.from), parseKey(b.ref.from)];
  if (!af || !bf) return 0;
  const [at, bt] = [parseKey(a.ref.to) ?? af, parseKey(b.ref.to) ?? bf];
  return compareKeys(af, bf) || compareKeys(at, bt);
}

function renderQuestion(page: HTMLElement, data: QuestionFull, focus: Focus, reload: () => void): void {
  const { question: q } = data;
  const focusArgument = focus.argument ?? data.verses.find((v) => v.id === focus.verse)?.argumentId;
  if (focusArgument) openArguments.add(focusArgument);
  if (data.arguments.length === 1) openArguments.add(data.arguments[0]!.id);

  page.append(
    h(
      'div',
      { class: 'row topic-bar' },
      h('a', { class: 'grow', href: '#/discussions' }, '← ', t('discussions', 'All topics')),
      h('button', { type: 'button', class: 'button small', title: t('discussions', 'The topic with its subtopics, verses, ratings and interpretations, in both languages'), on: { click: () => saveDiscussion(data) } }, icon('download'), t('discussions', 'Save as JSON')),
    ),
    h('h1', null, text(q.title).text),
    h('p', { class: 'meta byline' }, personLink(q.author), ' · ', when(q.createdAt, q.updatedAt)),
    h('div', { class: 'md' }, localizedNodes(q.summaryMd, true)),
    h('div', { class: 'positions' }, h('span', { class: 'position pro' }, h('span', { class: 'side-dot pro' }), text(q.sides.pro).text), h('span', { class: 'vs' }, t('discussions', 'or')), h('span', { class: 'position con' }, h('span', { class: 'side-dot con' }), text(q.sides.con).text)),
    h('div', { class: 'scales' }, scaleCard(t('discussions', 'Users'), q.tally?.users, q.sides), scaleCard(t('discussions', 'AI'), q.tally?.ai, q.sides, q.tally?.aiStatus === 'pending')),
    h('p', { class: 'disclaimer' }, t('discussions', 'Each verse is one point for one position, or none. The AI rating is language models’ opinion of what the verses teach, not a theological verdict.')),
  );

  for (const argument of data.arguments.filter((a) => !a.deleted || data.verses.some((v) => v.argumentId === a.id))) {
    const verses = data.verses.filter((v) => v.argumentId === argument.id).sort(byBibleOrder);
    page.appendChild(argumentBlock(q, argument, verses, data.interpretations, focus.verse, reload));
  }
  page.appendChild(h('button', { type: 'button', class: 'button', on: { click: () => newArgument(q, reload) } }, icon('plus'), t('discussions', 'Add a subtopic')));

  if (focus.verse) requestAnimationFrame(() => document.getElementById(`v-${focus.verse}`)?.scrollIntoView({ block: 'center' }));
}

/** The topic as a JSON file (core/discussion-file.ts), as it is on the screen now. */
function saveDiscussion(data: QuestionFull): void {
  const file = discussionFile(data, CONFIG.apiUrl);
  download(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }), discussionFileName(text(data.question.title).text));
}

function argumentBlock(q: Question, argument: Argument, verses: ArgumentVerse[], interpretations: Interpretation[], focusVerse: string | undefined, reload: () => void): HTMLElement {
  const tally: Tallies | undefined = argument.tally;
  const block = h(
    'details',
    { class: 'argument', open: openArguments.has(argument.id), id: `a-${argument.id}` },
    h('summary', null, h('h3', null, text(argument.title).text), miniScore(t('discussions', 'Users'), tally?.users), miniScore(t('discussions', 'AI'), tally?.ai, tally?.aiStatus === 'pending')),
    h(
      'div',
      { class: 'argument-body' },
      h('p', { class: 'meta byline' }, personLink(argument.author), ' · ', when(argument.createdAt, argument.updatedAt)),
      text(argument.summaryMd).text ? h('div', { class: 'md argument-summary' }, localizedNodes(argument.summaryMd, true)) : null,
      verses.length ? verses.map((v) => verseCard(q, v, interpretations.filter((i) => i.verseId === v.id), focusVerse === v.id, reload)) : h('p', { class: 'hint' }, t('discussions', 'No verses yet. Add the first one.')),
      h('button', { type: 'button', class: 'button', on: { click: () => addVerses(q, argument, reload) } }, icon('plus'), t('discussions', 'Add a verse')),
    ),
  );
  block.addEventListener('toggle', () => (block.open ? openArguments.add(argument.id) : openArguments.delete(argument.id)));
  return block;
}

function verseCard(q: Question, verse: ArgumentVerse, interpretations: Interpretation[], focused: boolean, reload: () => void): HTMLElement {
  const me = currentUser()?.id;
  const tr = readerTranslation();
  const natives = tr ? rangeToNative(tr, verse.ref) : [];
  const first = natives[0];
  const link = first && tr ? formatRoute({ name: 'read', ref: { linkName: tr.linkName, book: first.book, parts: [{ chapter: first.chapter, verse: first.verse }] } }) : '#';
  const votes = verse.votes ?? { pro: 0, con: 0, none: 0 };

  const voteButton = (value: VoteValue, label: string, count: number, cls: string) =>
    h(
      'button',
      {
        type: 'button',
        class: ['vote-button', cls],
        'aria-pressed': String(votes.mine === value),
        title: label,
        on: {
          click: async () => {
            if (!requireSignIn()) return;
            try {
              await api.vote(verse.id, votes.mine === value ? null : value);
              tagCache.clear();
              reload();
            } catch (error) {
              toast((error as Error).message, 'error');
            }
          },
        },
      },
      h('span', { class: 'label' }, label),
      h('span', { class: 'count' }, String(count)),
    );

  const score = (i: Interpretation) => (i.votes?.up ?? 0) - (i.votes?.down ?? 0);
  const column = (sideName: 'pro' | 'con') => {
    // The best rated first; equal ones in the order they were written.
    const own = interpretations.filter((i) => i.side === sideName).sort((a, b) => score(b) - score(a) || a.createdAt.localeCompare(b.createdAt));
    return h(
      'div',
      { class: ['side-col', sideName] },
      h('h4', null, h('span', { class: ['side-dot', sideName] }), text(sideName === 'pro' ? q.sides.pro : q.sides.con).text),
      own.map((i) => interpretationBlock(q, verse, i, interpretations, me, reload)),
      h('button', { type: 'button', class: 'button small ghost', on: { click: () => newInterpretation(q, verse, sideName, undefined, reload) } }, icon('plus'), t('discussions', 'Add an interpretation')),
    );
  };

  const verdicts = verse.ai?.verdicts ?? [];
  const canDelete = verse.author?.id === me && !interpretations.length;
  return h(
    'article',
    { class: ['stone', `outcome-${outcomeClass(verse.users?.outcome)}`, focused && 'focus'], id: `v-${verse.id}` },
    h(
      'header',
      { class: 'stone-head' },
      h('a', { class: 'stone-ref', href: link }, rangeLabel(verse.ref, tr)),
      h('span', { class: 'spacer' }),
      h('span', { class: ['outcome', outcomeClass(verse.users?.outcome)], title: t('discussions', 'The users’ result') }, `${t('discussions', 'Users')}: ${outcomeLabel(verse.users?.outcome, q.sides)}`),
      verse.ai?.status === 'pending'
        ? h('span', { class: 'outcome open' }, h('span', { class: 'pending' }, t('discussions', 'AI…')))
        : h('span', { class: ['outcome', outcomeClass(verse.ai?.outcome)], title: t('discussions', 'The AI’s result') }, `${t('discussions', 'AI')}: ${outcomeLabel(verse.ai?.outcome, q.sides)}`),
    ),
    // The full text first; votes and the interpretations come under it.
    natives.length
      ? h('p', { class: 'stone-text' }, natives.map((loc) => [natives.length > 1 ? h('sup', null, String(loc.verse)) : null, `${(verseText(tr!, loc) ?? '').replace(/[[\]]/g, '')} `]))
      : h('p', { class: 'stone-text missing' }, t('discussions', 'The verse text is not in the translation being read.')),
    h(
      'div',
      { class: 'stone-vote', role: 'group', 'aria-label': t('discussions', 'What does this verse teach?') },
      h('span', { class: 'hint' }, t('discussions', 'The verse confirms:')),
      voteButton(1, text(q.sides.pro).text, votes.pro, 'pro'),
      voteButton(0, t('discussions', 'Not relevant'), votes.none, 'none'),
      voteButton(-1, text(q.sides.con).text, votes.con, 'con'),
    ),
    h('div', { class: 'sides' }, column('pro'), column('con')),
    h(
      'footer',
      { class: 'stone-foot' },
      verdicts.length
        ? h(
            'details',
            { class: 'verdicts' },
            h('summary', null, t('discussions', 'Why the AI rated it so')),
            verdicts.map((v) => h('div', { class: 'verdict' }, h('b', null, `${v.model} · ${outcomeLabel(v.value, q.sides)} · ${Math.round(v.confidence * 100)}%`), localizedNodes(v.rationaleMd, true))),
          )
        : h('span'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint byline' }, t('discussions', 'added by'), ' ', personLink(verse.author), ' · ', when(verse.createdAt)),
      canDelete
        ? h(
            'button',
            {
              type: 'button',
              class: 'button ghost small danger',
              on: {
                click: async () => {
                  if (!(await confirmDialog(t('discussions', 'Remove the verse from the subtopic?'), t('discussions', 'Possible while no one else has voted for it and there are no interpretations.'), t('discussions', 'Remove'), true))) return;
                  try {
                    await api.deleteVerse(verse.id);
                    tagCache.clear();
                    refreshMarkers();
                    reload();
                  } catch (error) {
                    toast(error instanceof ApiError && error.code === 'in_use' ? t('discussions', 'Others have voted for this verse already: it stays.') : (error as Error).message, 'error');
                  }
                },
              },
            },
            t('discussions', 'Remove'),
          )
        : null,
    ),
  );
}

function interpretationBlock(q: Question, verse: ArgumentVerse, item: Interpretation, all: Interpretation[], me: string | undefined, reload: () => void): HTMLElement {
  const replyTo = item.replyTo ? all.find((i) => i.id === item.replyTo) : undefined;
  return h(
    'div',
    { class: ['point', item.side], id: `i-${item.id}` },
    replyTo ? h('div', { class: 'reply-to' }, '↪ ', t('discussions', 'in reply to {name}', { name: replyTo.author.displayName })) : null,
    item.deleted ? h('p', { class: 'hint' }, t('discussions', 'Deleted by the author.')) : h('div', { class: 'md' }, localizedNodes(item.bodyMd, true)),
    h(
      'div',
      { class: 'point-foot' },
      h('span', { class: 'byline' }, personLink(item.author), ' · ', when(item.createdAt, item.updatedAt)),
      h('span', { class: 'spacer' }),
      item.deleted ? null : rating(item, item.author.id === me, reload),
      item.deleted ? null : h('button', { type: 'button', class: 'button ghost small', on: { click: () => newInterpretation(q, verse, item.side === 'pro' ? 'con' : 'pro', item, reload) } }, t('discussions', 'Reply')),
      !item.deleted && item.author.id === me
        ? h(
            'button',
            {
              type: 'button',
              class: 'button ghost small danger',
              on: {
                click: async () => {
                  if (!(await confirmDialog(t('discussions', 'Delete your interpretation?'), t('discussions', 'If others replied to it, it stays as “deleted by the author”.'), t('discussions', 'Delete'), true))) return;
                  try {
                    await api.deleteInterpretation(item.id);
                    reload();
                  } catch (error) {
                    toast((error as Error).message, 'error');
                  }
                },
              },
            },
            t('discussions', 'Delete'),
          )
        : null,
    ),
  );
}

/** + and − of an interpretation, each with how many people chose it. One's own cannot be rated. */
function rating(item: Interpretation, own: boolean, reload: () => void): HTMLElement {
  const votes = item.votes ?? { up: 0, down: 0 };
  const button = (value: 1 | -1, glyph: string, count: number, title: string) =>
    h(
      'button',
      {
        type: 'button',
        class: ['rate', value === 1 ? 'up' : 'down'],
        title: own ? t('discussions', 'Your own interpretation cannot be rated') : title,
        'aria-label': `${title}: ${count}`,
        'aria-pressed': String(votes.mine === value),
        disabled: own,
        on: {
          click: async () => {
            if (!requireSignIn()) return;
            try {
              await api.rateInterpretation(item.id, votes.mine === value ? null : value);
              reload();
            } catch (error) {
              toast((error as Error).message, 'error');
            }
          },
        },
      },
      glyph,
      h('span', { class: 'count' }, String(count)),
    );
  return h('span', { class: 'rating' }, button(1, '+', votes.up, t('discussions', 'Agree with the interpretation')), button(-1, '−', votes.down, t('discussions', 'Disagree with the interpretation')));
}

/* ---------------- forms ---------------- */

function formError(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) return t('discussions', 'Not accepted: {reason}', { reason: error.reason ?? error.message });
  return (error as Error).message;
}

interface Sending {
  element: HTMLElement;
  busy: () => boolean;
  run: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * A published text goes through moderation and translation before the server answers, which
 * takes seconds and sometimes much longer. Meanwhile the form shows a running bar and says
 * what is happening, and it is locked so the text can't be sent twice or the dialog closed
 * on a request that will still be saved.
 */
function sending(): Sending {
  const label = h('span', { class: 'hint' });
  const element = h('div', { class: 'sending', role: 'status', hidden: true }, h('div', { class: 'progress running' }, h('div')), label);
  let busy = false;
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    const box = element.closest('.dialog') ?? element;
    const controls = [...box.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, textarea, select, button')].filter((c) => !c.disabled);
    const slow = setTimeout(() => (label.textContent = t('discussions', 'Still checking: the text is moderated and translated. It can take up to a minute.')), 5000);
    busy = true;
    label.textContent = t('discussions', 'Checking the text…');
    element.hidden = false;
    for (const c of controls) c.disabled = true;
    try {
      return await task();
    } finally {
      clearTimeout(slow);
      busy = false;
      element.hidden = true;
      for (const c of controls) c.disabled = false;
    }
  };
  return { element, busy: () => busy, run };
}

/** Typed references («Ин 1:1; Рим 5:8-9») → canonical ranges, in the numbering of the translation being read. */
function parseVerseInput(value: string): { ranges: RefRange[]; error?: string } {
  const tr = readerTranslation();
  const parsed = parseRefs(value);
  if (!parsed || !tr) return { ranges: [], error: t('discussions', 'Not a verse reference.') };
  const ranges: RefRange[] = [];
  for (const ref of parsed) {
    const found = refToRanges(tr, ref);
    if (!found.length) return { ranges: [], error: t('discussions', 'Noncanonical verses cannot be used in discussions.') };
    // A reference is one stone: its first and last canonical verse.
    ranges.push({ from: found[0]!.from, to: found.at(-1)!.to });
  }
  return { ranges };
}

/** Adds ranges to a subtopic; a verse already there is reported, not repeated. Returns the id to show. */
async function addRanges(argument: Argument, ranges: RefRange[]): Promise<string | undefined> {
  let last: string | undefined;
  for (const range of ranges) {
    try {
      last = (await api.addVerse(argument.id, range)).id;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'duplicate_verse') {
        toast(t('discussions', '{verse} is already in this subtopic.', { verse: rangeLabel(range) }));
        last = error.existingId ?? last;
      } else throw error;
    }
  }
  return last;
}

function addVerses(q: Question, argument: Argument, reload: () => void): void {
  if (!requireSignIn()) return;
  const input = h('input', { class: 'input', placeholder: t('discussions', 'John 1:1; Rom 5:8-9'), autofocus: true });
  const error = h('p', { class: 'error' });
  const submit = async () => {
    const { ranges, error: problem } = parseVerseInput(input.value);
    if (problem) return (error.textContent = problem);
    try {
      const id = await addRanges(argument, ranges);
      handle.close();
      tagCache.clear();
      refreshMarkers();
      const target = formatRoute({ name: 'discussion', id: q.id, ...(id ? { verse: id } : { argument: argument.id }) });
      if (location.hash === target) reload();
      else location.hash = target;
    } catch (e) {
      error.textContent = formError(e);
    }
    return undefined;
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  });
  const handle = dialog({
    title: t('discussions', 'Add a verse'),
    body: h(
      'div',
      null,
      h('p', { class: 'hint' }, text(argument.title).text),
      h('label', { class: 'field' }, h('span', null, t('discussions', 'Verses (a range is one stone; several — separated by “;”)')), input),
      h('p', { class: 'hint' }, t('discussions', 'The verse is shared by both sides: then everyone votes on what it teaches and explains it in their column.')),
      error,
    ),
    actions: [h('button', { type: 'button', class: 'button', on: { click: () => handle.close() } }, t('dialog', 'Cancel')), h('button', { type: 'button', class: 'button primary', on: { click: submit } }, t('discussions', 'Add'))],
  });
}

function newInterpretation(q: Question, verse: ArgumentVerse, sideName: 'pro' | 'con', replyTo: Interpretation | undefined, reload: () => void): void {
  if (!requireSignIn()) return;
  const ed = editor('', { placeholder: t('discussions', 'What the verse means and why it supports this position.') });
  const sideSelect = h('select', { class: 'select' }, h('option', { value: 'pro' }, text(q.sides.pro).text), h('option', { value: 'con' }, text(q.sides.con).text));
  sideSelect.value = sideName;
  const error = h('p', { class: 'error' });
  const send = sending();
  const submit = async () => {
    if (send.busy()) return undefined;
    const body = ed.value();
    if (!body) return (error.textContent = t('discussions', 'Write the interpretation.'));
    if (ed.problem()) return (error.textContent = ed.problem() ?? '');
    try {
      error.textContent = '';
      await send.run(() => api.addInterpretation(verse.id, { side: sideSelect.value as 'pro' | 'con', bodyMd: body, lang: uiLang(), ...(replyTo ? { replyTo: replyTo.id } : {}) }));
      handle.close();
      toast(t('discussions', 'Added. The AI is re-evaluating the verse.'));
      reload();
    } catch (e) {
      error.textContent = formError(e);
    }
    return undefined;
  };
  const handle = dialog({
    title: replyTo ? t('discussions', 'Reply') : t('discussions', 'Interpretation · {verse}', { verse: rangeLabel(verse.ref) }),
    wide: true,
    canClose: () => !send.busy(),
    body: h('div', null, h('label', { class: 'field' }, h('span', null, t('discussions', 'Column')), sideSelect), ed.element, error, send.element),
    actions: [h('button', { type: 'button', class: 'button', on: { click: () => handle.close() } }, t('dialog', 'Cancel')), h('button', { type: 'button', class: 'button primary', on: { click: submit } }, t('discussions', 'Publish'))],
  });
}

function newArgument(q: Question, reload: () => void, then?: (argument: Argument) => void): void {
  if (!requireSignIn()) return;
  const title = h('input', { class: 'input', maxLength: 200 });
  const ed = editor('', { rows: 4, placeholder: t('discussions', 'What this subtopic is about (optional)') });
  const error = h('p', { class: 'error' });
  const send = sending();
  const submit = async () => {
    if (send.busy()) return undefined;
    if (!title.value.trim()) return (error.textContent = t('discussions', 'Give the subtopic a title.'));
    try {
      error.textContent = '';
      const argument = await send.run(() => api.addArgument(q.id, { title: title.value.trim(), summaryMd: ed.value(), lang: uiLang() }));
      handle.close();
      openArguments.add(argument.id);
      if (then) then(argument);
      else reload();
    } catch (e) {
      error.textContent = formError(e);
    }
    return undefined;
  };
  const handle = dialog({
    title: t('discussions', 'New subtopic'),
    wide: true,
    canClose: () => !send.busy(),
    body: h('div', null, h('label', { class: 'field' }, h('span', null, t('discussions', 'Title, e.g. “The deity of Jesus”')), title), ed.element, error, send.element),
    actions: [h('button', { type: 'button', class: 'button', on: { click: () => handle.close() } }, t('dialog', 'Cancel')), h('button', { type: 'button', class: 'button primary', on: { click: submit } }, t('discussions', 'Publish'))],
  });
}

function newQuestion(): void {
  if (!requireSignIn()) return;
  const title = h('input', { class: 'input', maxLength: 200 });
  const pro = h('input', { class: 'input', value: t('discussions', 'Consistent with the Bible'), maxLength: 60 });
  const con = h('input', { class: 'input', value: t('discussions', 'Not consistent with the Bible'), maxLength: 60 });
  const tags = h('input', { class: 'input', placeholder: t('discussions', 'theology, christology') });
  const ed = editor('', { rows: 4, placeholder: t('discussions', 'What exactly is being asked') });
  const error = h('p', { class: 'error' });
  const send = sending();
  const submit = async () => {
    if (send.busy()) return undefined;
    if (!title.value.trim()) return (error.textContent = t('discussions', 'Write the topic.'));
    try {
      error.textContent = '';
      const q = await send.run(() =>
        api.createQuestion({
          title: title.value.trim(),
          summaryMd: ed.value(),
          sides: { pro: pro.value.trim() || t('discussions', 'For'), con: con.value.trim() || t('discussions', 'Against') },
          tags: tags.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10),
          lang: uiLang(),
        }),
      );
      handle.close();
      location.hash = formatRoute({ name: 'discussion', id: q.id });
    } catch (e) {
      error.textContent = formError(e);
    }
    return undefined;
  };
  const handle = dialog({
    title: t('discussions', 'New topic'),
    wide: true,
    canClose: () => !send.busy(),
    body: h(
      'div',
      null,
      h('label', { class: 'field' }, h('span', null, t('discussions', 'Topic (a question)')), title),
      ed.element,
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', null, t('discussions', 'The first position')), pro), h('label', { class: 'field grow' }, h('span', null, t('discussions', 'The second position')), con)),
      h('label', { class: 'field' }, h('span', null, t('discussions', 'Tags, separated by commas')), tags),
      error,
      send.element,
    ),
    actions: [h('button', { type: 'button', class: 'button', on: { click: () => handle.close() } }, t('dialog', 'Cancel')), h('button', { type: 'button', class: 'button primary', on: { click: submit } }, t('discussions', 'Publish'))],
  });
}

/** From the reader's selection: choose a topic and a subtopic; the verses go in as one stone. */
export async function addToDiscussion(ranges: RefRange[]): Promise<void> {
  if (!ranges.length) return;
  if (!(await serverUp())) return toast(t('discussions', 'No connection to the server. Discussions need the internet.'), 'error');
  if (!requireSignIn()) return;
  await loadTranslation();
  let questions: Question[];
  try {
    questions = await api.questions(uiLang());
  } catch (error) {
    return toast((error as Error).message, 'error');
  }
  const stone: RefRange = { from: ranges[0]!.from, to: ranges.at(-1)!.to };
  const questionSelect = h('select', { class: 'select' }, h('option', { value: '' }, t('discussions', '— choose a topic —')), questions.filter((q) => !q.deleted).map((q) => h('option', { value: q.id }, text(q.title).text)));
  const argumentSelect = h('select', { class: 'select', disabled: true });
  const newArgumentButton = h('button', { type: 'button', class: 'button ghost small', disabled: true }, icon('plus'), t('discussions', 'New subtopic'));
  let full: QuestionFull | null = null;
  questionSelect.addEventListener('change', async () => {
    full = null;
    argumentSelect.replaceChildren();
    if (!questionSelect.value) return;
    full = await api.question(questionSelect.value, uiLang());
    argumentSelect.append(...full.arguments.filter((a) => !a.deleted).map((a) => h('option', { value: a.id }, text(a.title).text)));
    argumentSelect.disabled = !full.arguments.length;
    newArgumentButton.disabled = false;
  });
  const go = async (argument: Argument) => {
    try {
      const id = await addRanges(argument, [stone]);
      tagCache.clear();
      refreshMarkers();
      location.hash = formatRoute({ name: 'discussion', id: argument.questionId, ...(id ? { verse: id } : { argument: argument.id }) });
    } catch (error) {
      toast(formError(error), 'error');
    }
  };
  newArgumentButton.addEventListener('click', () => {
    if (!full) return;
    handle.close();
    newArgument(full.question, () => undefined, (argument) => void go(argument));
  });
  const next = () => {
    if (!full) return toast(t('discussions', 'Choose a topic.'), 'error');
    const argument = full.arguments.find((a) => a.id === argumentSelect.value);
    if (!argument) return toast(t('discussions', 'The topic has no subtopics yet: add one.'), 'error');
    handle.close();
    void go(argument);
    return undefined;
  };
  const handle = dialog({
    title: t('discussions', 'Use {verse} in a discussion', { verse: rangeLabel(stone) }),
    body: h(
      'div',
      null,
      h('label', { class: 'field' }, h('span', null, t('discussions', 'Topic')), questionSelect),
      h('label', { class: 'field' }, h('span', null, t('discussions', 'Subtopic')), argumentSelect),
      newArgumentButton,
      h('p', { class: 'hint' }, t('discussions', 'The verse is shared by both sides: then everyone votes on what it teaches and explains it in their column.')),
    ),
    actions: [h('button', { type: 'button', class: 'button', on: { click: () => handle.close() } }, t('dialog', 'Cancel')), h('button', { type: 'button', class: 'button primary', on: { click: next } }, t('discussions', 'Add the verse'))],
  });
  return undefined;
}
