/**
 * The discussions API's shapes, as docs/api.md describes them and the Python
 * stub (server/) answers. JSON, camelCase.
 */

import type { Lang, RefRange, VerseKey } from './types';

/** Every language the server has; `orig` is the one the author wrote in. */
export interface LocalizedText {
  orig: Lang;
  ru?: string;
  en?: string;
}

export interface User {
  id: string;
  provider: 'google' | 'apple' | 'microsoft';
  displayName: string;
  createdAt: string;
}

export interface Author {
  id: string;
  displayName: string;
}

/** 1 — confirms the first position, -1 — the second, 0 — not relevant. */
export type VoteValue = -1 | 0 | 1;

/** A verse's result; null — undecided (no votes, or the two leading options tie). */
export type Outcome = VoteValue | null;

/** Verse outcomes added up: points of the first position, of the second, not relevant, undecided. */
export interface Tally {
  pro: number;
  con: number;
  none: number;
  open: number;
}

export interface Tallies {
  users: Tally;
  ai: Tally;
  aiStatus: 'fresh' | 'pending' | 'none';
}

export interface VerseVotes {
  pro: number;
  con: number;
  none: number;
  mine?: VoteValue | null;
}

export interface VerseVerdict {
  verseId: string;
  model: string;
  value: VoteValue;
  confidence: number;
  rationaleMd: LocalizedText;
  inputHash: string;
  createdAt: string;
}

export interface Question {
  id: string;
  title: LocalizedText;
  summaryMd: LocalizedText;
  sides: { pro: LocalizedText; con: LocalizedText };
  tags: string[];
  author: Author;
  createdAt: string;
  updatedAt?: string;
  deleted?: boolean;
  tally: Tallies;
  argumentCount?: number;
  verseCount?: number;
}

export interface Argument {
  id: string;
  questionId: string;
  title: LocalizedText;
  summaryMd: LocalizedText;
  author: Author;
  createdAt: string;
  updatedAt?: string;
  deleted?: boolean;
  tally: Tallies;
}

/** A "stone": a verse or a range in a subtopic, shared by both sides. */
export interface ArgumentVerse {
  id: string;
  argumentId: string;
  questionId: string;
  ref: RefRange;
  author: Author;
  createdAt: string;
  votes: VerseVotes;
  users: { outcome: Outcome };
  ai: { outcome: Outcome; status: 'fresh' | 'pending' | 'none'; verdicts: VerseVerdict[] };
}

export interface Interpretation {
  id: string;
  verseId: string;
  argumentId: string;
  questionId: string;
  side: 'pro' | 'con';
  bodyMd: LocalizedText;
  replyTo?: string;
  author: Author;
  createdAt: string;
  updatedAt?: string;
  deleted?: boolean;
  /** How many rated it + and −; `mine` only when signed in. */
  votes: { up: number; down: number; mine?: 1 | -1 | null };
}

export interface QuestionFull {
  question: Question;
  arguments: Argument[];
  verses: ArgumentVerse[];
  interpretations: Interpretation[];
}

export interface VerseTag {
  key: VerseKey;
  questionId: string;
  questionTitle: LocalizedText;
  argumentId: string;
  argumentTitle?: LocalizedText;
  verseId: string;
  users: Outcome;
  ai: Outcome;
}

export interface VoteResult {
  votes: VerseVotes;
  users: { outcome: Outcome };
  argument: { id: string; tally: Tallies };
  question: { id: string; tally: Tallies };
}

export interface VerseRating extends VoteResult {
  ai: ArgumentVerse['ai'];
}


export interface ApiErrorBody {
  error: { code: string; message: string; reason?: string };
}

export function localized(text: LocalizedText | undefined, lang: Lang): { text: string; translated: boolean } {
  if (!text) return { text: '', translated: false };
  const own = text[lang];
  if (own !== undefined && own !== '') return { text: own, translated: text.orig !== lang };
  return { text: text[text.orig] ?? '', translated: false };
}
