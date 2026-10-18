/**
 * Verse numbering of a translation ⇄ the canonical (KJV) numbering.
 *
 * Comments, discussion tags and comparison hang on canonical keys, so that a
 * comment on Synodal Ps 22 lands on KJV Ps 23, the same psalm. Each
 * translation file names its scheme (`versification`); this module turns a
 * verse of that scheme into a canonical one and back.
 *
 * The mapping is not one-to-one: a Psalm title that is a verse of its own in
 * the Synodal merges into KJV verse 1, and here and there one Synodal verse
 * holds two KJV verses. toCanonical answers with the first canonical verse;
 * toCanonicalAll lists them all. Verses with no canonical counterpart
 * (deuterocanonical books, insertions such as Dan 3:24–90) have none: null,
 * and the app keeps them out of everything that works on canonical keys.
 */
import type { AnyBookId, BookId } from '../books';
import { isCanonicalBook } from '../books';
import { KJV_COUNTS } from './kjv-counts';
import {
  SYNODAL_MISSING,
  SYNODAL_NONCANONICAL,
  SYNODAL_PSALM_CHAPTERS,
  SYNODAL_PSALM_TITLE_VERSES,
  SYNODAL_RULES,
} from './synodal';

export interface VerseLoc {
  book: AnyBookId;
  chapter: number;
  verse: number;
}

export interface CanonLoc {
  book: BookId;
  chapter: number;
  verse: number;
}

export interface Versification {
  id: string;
  /** null for noncanonical: deuterocanonical books and insertions. A Psalm title verse merges into the verse it belongs to. */
  toCanonical(loc: VerseLoc): CanonLoc | null;
  /** Every canonical verse a native verse holds: usually one, several when it joins them, none when noncanonical. */
  toCanonicalAll(loc: VerseLoc): CanonLoc[];
  /** Native verses for a canonical one: usually one; empty when the translation lacks it; several when it splits. */
  fromCanonical(loc: CanonLoc): VerseLoc[];
  isNoncanonical(loc: VerseLoc): boolean;
}

/** The rules of a scheme, as written in its file (see synodal.ts). */
interface Scheme {
  id: string;
  rules: Partial<Record<BookId, readonly string[]>>;
  noncanonical: Partial<Record<BookId, readonly string[]>>;
  missing: Partial<Record<BookId, readonly string[]>>;
  /** Extra rules computed from compact tables (the Synodal Psalter). */
  extraRules?: () => Partial<Record<BookId, string[]>>;
}

type Point = readonly [chapter: number, verse: number];

const key = (book: string, chapter: number, verse: number) => `${book}.${chapter}.${verse}`;
const before = (a: Point, b: Point) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

const RULE = /^(\d+):(\d+)(?:-(\d+))?\s*=\s*(\d+):(\d+)(?:-(\d+))?$/;

function expand(chapter: number, from: number, to: number): Point[] {
  const points: Point[] = [];
  for (let verse = from; verse <= to; verse += 1) points.push([chapter, verse]);
  return points;
}

/** Native verse → canonical verses, and back, for every verse a rule mentions. */
class Table {
  readonly forward = new Map<string, CanonLoc[]>();
  readonly backward = new Map<string, VerseLoc[]>();
  readonly noncanonical = new Map<string, [Point, Point][]>();
  readonly missing = new Set<string>();

  constructor(scheme: Scheme) {
    const extra = scheme.extraRules?.() ?? {};
    const books = new Set([...Object.keys(scheme.rules), ...Object.keys(extra)]) as Set<BookId>;
    for (const book of books) {
      for (const rule of [...(scheme.rules[book] ?? []), ...(extra[book] ?? [])]) this.addRule(book, rule);
    }
    for (const [book, ranges] of Object.entries(scheme.noncanonical)) {
      this.noncanonical.set(
        book,
        (ranges ?? []).map((range) => {
          const m = /^(\d+)\.(\d+)-(\d+)\.(\d+)$/.exec(range);
          if (!m) throw new Error(`${scheme.id}: bad range ${book} ${range}`);
          return [
            [Number(m[1]), Number(m[2])],
            [Number(m[3]), Number(m[4])],
          ];
        }),
      );
    }
    for (const [book, verses] of Object.entries(scheme.missing)) {
      for (const verse of verses ?? []) this.missing.add(`${book}.${verse}`);
    }
  }

  private addRule(book: BookId, rule: string) {
    const m = RULE.exec(rule);
    if (!m) throw new Error(`bad rule ${book} ${rule}`);
    const [nc, nf, nt, kc, kf, kt] = [m[1], m[2], m[3] ?? m[2], m[4], m[5], m[6] ?? m[5]].map(Number) as [
      number, number, number, number, number, number,
    ];
    const native = expand(nc, nf, nt);
    const canon = expand(kc, kf, kt);
    let pairs: [Point, Point][];
    if (native.length === canon.length) pairs = native.map((n, i) => [n, canon[i] as Point]);
    else if (native.length === 1) pairs = canon.map((k) => [native[0] as Point, k]);
    else if (canon.length === 1) pairs = native.map((n) => [n, canon[0] as Point]);
    else throw new Error(`rule ${book} ${rule}: ${native.length} verses against ${canon.length}`);
    for (const [[c, v], [kc2, kv]] of pairs) {
      const nk = key(book, c, v);
      const kk = key(book, kc2, kv);
      const fwd = this.forward.get(nk) ?? [];
      if (!fwd.some((loc) => loc.chapter === kc2 && loc.verse === kv)) fwd.push({ book, chapter: kc2, verse: kv });
      this.forward.set(nk, fwd);
      const back = this.backward.get(kk) ?? [];
      if (!back.some((loc) => loc.chapter === c && loc.verse === v)) back.push({ book, chapter: c, verse: v });
      this.backward.set(kk, back);
    }
  }

  isInsertion(loc: VerseLoc): boolean {
    const point: Point = [loc.chapter, loc.verse];
    return (this.noncanonical.get(loc.book) ?? []).some(([from, to]) => !before(point, from) && !before(to, point));
  }
}

/**
 * The Synodal Psalter in rules: the chapter shift of SYNODAL_PSALM_CHAPTERS
 * and the title verses of SYNODAL_PSALM_TITLE_VERSES, for every psalm the
 * explicit rules do not already cover. KJV verse counts bound the ranges.
 */
function synodalPsalmRules(): Partial<Record<BookId, string[]>> {
  const explicit = new Set((SYNODAL_RULES.PSA ?? []).map((rule) => Number(rule.split(':')[0])));
  const titles = new Map<number, number>();
  for (const count of [1, 2] as const) for (const psalm of SYNODAL_PSALM_TITLE_VERSES[count]) titles.set(psalm, count);
  const rules: string[] = [];
  for (const [first, last, shift] of SYNODAL_PSALM_CHAPTERS) {
    for (let native = first; native <= last; native += 1) {
      if (explicit.has(native)) continue;
      const kjv = native + shift;
      const verses = KJV_COUNTS.PSA[kjv - 1];
      if (!verses) throw new Error(`Synodal Ps ${native}: no KJV Ps ${kjv}`);
      const t = titles.get(native) ?? 0;
      if (t === 0) {
        if (shift !== 0) rules.push(`${native}:1-${verses} = ${kjv}:1-${verses}`);
        continue;
      }
      rules.push(`${native}:1-${t + 1} = ${kjv}:1`);
      if (verses > 1) rules.push(`${native}:${t + 2}-${verses + t} = ${kjv}:2-${verses}`);
    }
  }
  return { PSA: rules };
}

const SCHEMES: Record<string, Scheme> = {
  synodal: {
    id: 'synodal',
    rules: SYNODAL_RULES,
    noncanonical: SYNODAL_NONCANONICAL,
    missing: SYNODAL_MISSING,
    extraRules: synodalPsalmRules,
  },
};

/** KJV numbering itself, and the fallback for a scheme the app does not know. */
function identity(id: string): Versification {
  const toCanonicalAll = (loc: VerseLoc): CanonLoc[] =>
    isCanonicalBook(loc.book) ? [{ book: loc.book, chapter: loc.chapter, verse: loc.verse }] : [];
  return {
    id,
    toCanonical: (loc) => toCanonicalAll(loc)[0] ?? null,
    toCanonicalAll,
    fromCanonical: (loc) => [{ book: loc.book, chapter: loc.chapter, verse: loc.verse }],
    isNoncanonical: (loc) => !isCanonicalBook(loc.book),
  };
}

function fromScheme(scheme: Scheme): Versification {
  let built: Table | undefined;
  // Built on first use: the Psalter rules need KJV counts, and most sessions
  // never leave KJV numbering.
  const table = () => (built ??= new Table(scheme));

  const isNoncanonical = (loc: VerseLoc) => !isCanonicalBook(loc.book) || table().isInsertion(loc);

  const toCanonicalAll = (loc: VerseLoc): CanonLoc[] => {
    if (!isCanonicalBook(loc.book) || table().isInsertion(loc)) return [];
    const mapped = table().forward.get(key(loc.book, loc.chapter, loc.verse));
    if (mapped) return mapped.map((canon) => ({ ...canon }));
    return [{ book: loc.book, chapter: loc.chapter, verse: loc.verse }];
  };

  const fromCanonical = (loc: CanonLoc): VerseLoc[] => {
    const t = table();
    const k = key(loc.book, loc.chapter, loc.verse);
    if (t.missing.has(k)) return [];
    // A canonical verse a rule points at comes only from the rules; otherwise
    // the native verse of the same number holds it, unless a rule moved that
    // one elsewhere or it is an insertion.
    const mapped = t.backward.get(k);
    if (mapped) return mapped.map((native) => ({ ...native }));
    const same: VerseLoc = { book: loc.book, chapter: loc.chapter, verse: loc.verse };
    if (t.forward.has(k) || t.isInsertion(same)) return [];
    return [same];
  };

  return {
    id: scheme.id,
    toCanonical: (loc) => toCanonicalAll(loc)[0] ?? null,
    toCanonicalAll,
    fromCanonical,
    isNoncanonical,
  };
}

/**
 * The noncanonical insertion ranges a scheme's table lists for a book
 * ("chapter.verse-chapter.verse"), which a translation file must repeat:
 * [] for none, undefined for a scheme without a table (nothing to compare).
 */
export function noncanonicalRanges(scheme: string, book: string): string[] | undefined {
  if (scheme === 'kjv') return [];
  const found = SCHEMES[scheme];
  return found ? [...(found.noncanonical[book as BookId] ?? [])] : undefined;
}

const cache = new Map<string, Versification>();

/** The versification a translation file names: 'kjv' (identity) or 'synodal'; an unknown id falls back to identity. */
export function versification(id: string): Versification {
  let found = cache.get(id);
  if (!found) {
    const scheme = SCHEMES[id];
    found = scheme ? fromScheme(scheme) : identity(id);
    cache.set(id, found);
  }
  return found;
}
