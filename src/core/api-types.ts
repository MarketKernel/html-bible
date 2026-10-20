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

export interface Person {
  id: string;
  displayName: string;
}

/** The signed-in user as they see themselves (the login is theirs alone). */
export interface User {
  id: string;
  /** Member number: root is 1, then in the order of registration. */
  number: number;
  /** Lowercase, unique, never changes. */
  login: string;
  displayName: string;
  createdAt: string;
  /** Who invited them; none for root. */
  invitedBy?: Person;
}

/** What anyone may see of a member: never the login or the codes. */
export interface PublicProfile {
  id: string;
  number: number;
  displayName: string;
  createdAt: string;
  invitedBy: Person | null;
  invitees: (Person & { createdAt: string })[];
}

/** The user's invitation codes: the limit, and each code with who used it. */
export interface InviteState {
  issued: number;
  limit: number;
  /** "YYYY-MM-DD": from 00:00 UTC of this day more codes can be taken. */
  resetOn: string | null;
  /** Codes that can be taken right now. */
  available: number;
  codes: { seq: number; code: string; usedBy?: Person & { at: string } }[];
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

/**
 * A stone's text in its original language, from the server's own table (WLC for
 * the Old Testament, SBLGNT for the New): what the AI judges by. One verse as is;
 * several, each line after its "chapter:verse". Empty: the edition has not got the verse.
 */
export interface VerseOriginal {
  lang: 'hbo' | 'grc';
  edition: string;
  text: string;
  /** A long range: only its start. */
  cut?: boolean;
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
  /** None while the server's table had not got it. */
  original?: VerseOriginal;
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
