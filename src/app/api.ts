/**
 * The discussions API (docs/api.md): fetch with the token when signed in. Errors come back as ApiError with the server's code, so forms can show
 * "rejected: …" (422) or "try again" (503) and keep what was typed.
 */

import type { Argument, ArgumentVerse, Interpretation, InviteState, Person, PublicProfile, Question, QuestionFull, User, VerseRating, VerseTag, VoteResult, VoteValue } from '../core/api-types';
import { CONFIG } from '../core/config';
import { t } from '../core/i18n';
import type { Lang, RefRange } from '../core/types';
import { authToken, sessionLost } from './auth-service';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason?: string,
    /** The existing item, for a 409 duplicate. */
    readonly existingId?: string,
    /** "YYYY-MM-DD" when more invitation codes come, for a 429 invite_limit. */
    readonly resetOn?: string,
  ) {
    super(message);
  }
}

export function apiAvailable(): boolean {
  return !!CONFIG.apiUrl;
}

async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
  if (!CONFIG.apiUrl) throw new ApiError(0, 'no_server', t('api', 'Discussions are not available in this build.'));
  const url = new URL(path.replace(/^\//, ''), CONFIG.apiUrl);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const headers: Record<string, string> = {};
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'offline', t('api', 'No connection to the server.'));
  }
  if (response.status === 204) return undefined as T;
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    if (response.status === 401 && token) sessionLost();
    const error = (json?.error ?? {}) as { code?: string; message?: string; reason?: string; id?: string; resetOn?: string };
    const message =
      response.status === 401 ? t('api', 'Sign in to do this.') : response.status === 503 ? t('api', 'The service is busy. Try again in a minute.') : (error.reason ?? error.message ?? t('api', 'Something went wrong ({status}).', { status: response.status }));
    throw new ApiError(response.status, error.code ?? 'error', message, error.reason, error.id, error.resetOn);
  }
  return json as T;
}

/** A list may come bare or wrapped ({ questions: […] }). */
function list<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  const inner = (value as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

let healthy: { at: number; ok: boolean } | null = null;

export async function serverUp(): Promise<boolean> {
  if (!CONFIG.apiUrl) return false;
  if (healthy && Date.now() - healthy.at < 30_000) return healthy.ok;
  try {
    await call('GET', 'health');
    healthy = { at: Date.now(), ok: true };
  } catch {
    healthy = { at: Date.now(), ok: false };
  }
  return healthy.ok;
}

export const api = {
  me: () => call<User>('GET', 'me'),
  profile: (id: string) => call<PublicProfile>('GET', `users/${encodeURIComponent(id)}`),
  invites: () => call<InviteState>('GET', 'invites'),
  newInvite: () => call<{ seq: number; code: string }>('POST', 'invites'),
  inviter: (code: string) => call<{ inviter: Person }>('GET', `invites/${encodeURIComponent(code.trim())}`),
  rename: (displayName: string) => call<User>('PATCH', 'me', { displayName }),
  questions: async (lang: Lang, tag?: string) => list<Question>(await call('GET', 'questions', undefined, { lang, tag }), 'questions'),
  question: (id: string, lang: Lang) => call<QuestionFull>('GET', `questions/${encodeURIComponent(id)}`, undefined, { lang }),
  createQuestion: (input: { title: string; summaryMd: string; sides: { pro: string; con: string }; tags: string[]; lang: Lang }) => call<Question>('POST', 'questions', input),
  addArgument: (questionId: string, input: { title: string; summaryMd: string; lang: Lang }) => call<Argument>('POST', `questions/${encodeURIComponent(questionId)}/arguments`, input),
  addVerse: (argumentId: string, ref: RefRange) => call<ArgumentVerse>('POST', `arguments/${encodeURIComponent(argumentId)}/verses`, { ref }),
  deleteVerse: (id: string) => call<unknown>('DELETE', `verses/${encodeURIComponent(id)}`),
  addInterpretation: (verseId: string, input: { side: 'pro' | 'con'; bodyMd: string; replyTo?: string; lang: Lang }) => call<Interpretation>('POST', `verses/${encodeURIComponent(verseId)}/interpretations`, input),
  deleteInterpretation: (id: string) => call<unknown>('DELETE', `interpretations/${encodeURIComponent(id)}`),
  rateInterpretation: (id: string, value: 1 | -1 | null) => call<{ votes: Interpretation['votes'] }>('PUT', `votes/interpretation/${encodeURIComponent(id)}`, { value }),
  vote: (verseId: string, value: VoteValue | null) => call<VoteResult>('PUT', `votes/verse/${encodeURIComponent(verseId)}`, { value }),
  rating: (verseId: string) => call<VerseRating>('GET', `verses/${encodeURIComponent(verseId)}/rating`),
  verseTags: async (book: string, chapter: number, lang: Lang) => list<VerseTag>(await call('GET', 'verse-tags', undefined, { book, chapter, lang }), 'tags'),
};
