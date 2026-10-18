/**
 * The user's own comments: only on this device, in IndexedDB. Exported as a
 * commentary file of the same format as Lopukhin's, which anyone can open as
 * a commentary; imported back (merging by id) from one's own export.
 */

import type { BookId } from '../core/books';
import { parseKey, parseRange, rangeText } from '../core/canon';
import { t } from '../core/i18n';
import { checkCommentary, PackError } from '../core/pack';
import type { Commentary, MyComment, RefRange } from '../core/types';
import { del, getAll, getAllByIndex, put, putMany } from './db';

interface Stored extends MyComment {
  /** The book of `ref.from` — the index. */
  book: BookId;
}

const listeners = new Set<() => void>();
export function onMyCommentsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const changed = () => listeners.forEach((l) => l());

/** Sortable, unique enough ids: time + randomness (ULID-like, Crockford base32). */
export function newId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i += 1) {
    head = alphabet[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let tail = '';
  for (const byte of random) tail += alphabet[byte % 32];
  return head + tail;
}

export async function commentsForBook(book: BookId): Promise<MyComment[]> {
  return getAllByIndex<Stored>('myComments', 'book', book);
}

export async function allComments(): Promise<MyComment[]> {
  return getAll<Stored>('myComments');
}

export async function saveComment(input: { id?: string; ref: RefRange; bodyMd: string }): Promise<MyComment> {
  const from = parseKey(input.ref.from);
  if (!from) throw new Error('A comment needs a canonical verse');
  const now = new Date().toISOString();
  const existing = input.id ? (await allComments()).find((c) => c.id === input.id) : undefined;
  const comment: Stored = {
    id: existing?.id ?? newId(),
    ref: input.ref,
    bodyMd: input.bodyMd,
    createdAt: existing?.createdAt ?? now,
    ...(existing ? { updatedAt: now } : {}),
    book: from.book,
  };
  await put('myComments', comment);
  changed();
  return comment;
}

export async function deleteComment(id: string): Promise<void> {
  await del('myComments', id);
  changed();
}

export async function exportComments(name: string, author: string): Promise<Blob> {
  const comments = await allComments();
  const commentary: Commentary = {
    format: 'html-bible/commentary',
    formatVersion: 1,
    id: `my-${newId().toLowerCase()}`,
    version: '1.0.0',
    lang: document.documentElement.lang || 'ru',
    name,
    ...(author ? { author } : {}),
    exportedAt: new Date().toISOString(),
    entries: comments.map((c) => ({
      id: c.id,
      ref: rangeText(c.ref),
      md: c.bodyMd,
      createdAt: c.createdAt,
      ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
    })),
  };
  return new Blob([JSON.stringify(commentary, null, 1)], { type: 'application/json' });
}

/** Adds the comments of one's own export back; the newer copy of a comment wins. Returns how many were added or updated. */
export async function importComments(file: File): Promise<number> {
  let json: unknown;
  try {
    json = JSON.parse((await file.text()).replace(/^﻿/, ''));
  } catch {
    throw new PackError(t('pack', 'The file is not valid JSON.'));
  }
  const commentary = checkCommentary(json);
  const existing = new Map((await allComments()).map((c) => [c.id, c]));
  const items: { value: Stored }[] = [];
  for (const entry of commentary.entries ?? []) {
    const ref = parseRange(entry.ref);
    if (!entry.id || !ref) continue;
    const from = parseKey(ref.from)!;
    const old = existing.get(entry.id);
    const stamp = entry.updatedAt ?? entry.createdAt ?? '';
    if (old && (old.updatedAt ?? old.createdAt) >= stamp) continue;
    items.push({ value: { id: entry.id, ref, bodyMd: entry.md, createdAt: entry.createdAt ?? new Date().toISOString(), ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}), book: from.book } });
  }
  if (!items.length && !(commentary.entries ?? []).some((e) => e.id)) throw new PackError(t('packs', 'These are not your exported comments. Open the file as a commentary instead.'));
  await putMany('myComments', items);
  changed();
  return items.length;
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
