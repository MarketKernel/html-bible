/**
 * Installed translations and commentaries: from the catalog (downloaded) or a
 * file the user opens. Everything is checked (core/pack.ts) before it is
 * stored; catalog downloads are also checked against the catalog's sha256.
 *
 * A translation is kept whole — the reader and search need all of it. A
 * commentary is kept per book: a big one (Lopukhin) from the catalog loads a
 * book the first time it is read, unless the user downloads it all.
 */

import { type BookId, isCanonicalBook } from '../core/books';
import { parseRange } from '../core/canon';
import { CONFIG, dataBase } from '../core/config';
import { t } from '../core/i18n';
import { checkCatalog, checkCommentary, checkCommentaryBook, identify, PackError } from '../core/pack';
import type { Catalog, CatalogCommentary, CatalogTranslation, Commentary, CommentaryEntry, PackMeta, Translation } from '../core/types';
import { deletePrefix, del, get, getAll, persist, put, putMany } from './db';

interface PackRecord {
  id: string;
  meta: PackMeta;
  /** The translation itself; for a commentary, nothing (entries are per book). */
  data?: Translation;
}

let installed: PackMeta[] = [];
const translations = new Map<string, Translation>();
const listeners = new Set<() => void>();

export function onPacksChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

export async function loadInstalled(): Promise<PackMeta[]> {
  const records = await getAll<PackRecord>('packs');
  installed = records.map((r) => r.meta).sort((a, b) => a.installedAt.localeCompare(b.installedAt));
  return installed;
}

export function installedPacks(kind?: PackMeta['kind']): PackMeta[] {
  return kind ? installed.filter((p) => p.kind === kind) : installed;
}

export function packMeta(id: string): PackMeta | undefined {
  return installed.find((p) => p.id === id);
}

export function translationByLinkName(linkName: string): PackMeta | undefined {
  const lower = linkName.toLowerCase();
  return installed.find((p) => p.kind === 'translation' && p.linkName?.toLowerCase() === lower);
}

export async function translation(id: string): Promise<Translation | undefined> {
  const cached = translations.get(id);
  if (cached) return cached;
  const record = await get<PackRecord>('packs', id);
  if (!record?.data) return undefined;
  translations.set(id, record.data);
  return record.data;
}

/** Loaded already — for code that cannot wait (rendering a verse's tooltip). */
export function translationNow(id: string): Translation | undefined {
  return translations.get(id);
}

/* ---------------- fetching ---------------- */

export type Progress = (loaded: number, total: number) => void;

async function fetchBytes(url: string, onProgress?: Progress, expected = 0): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new PackError(t('packs', 'Download failed: {status}.', { status: response.status }));
  const total = Number(response.headers.get('content-length')) || expected;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** gzip (by its magic bytes) is unpacked; anything else is taken as UTF-8 text. */
async function toText(bytes: Uint8Array): Promise<string> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

async function toJson(bytes: Uint8Array): Promise<unknown> {
  const text = await toText(bytes);
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new PackError(t('pack', 'The file is not valid JSON.'));
  }
}

const DATA = dataBase(CONFIG, location.href);
const dataUrl = (path: string) => new URL(path, DATA).href;

/** False for a build that downloads nothing (the demo): only files can be opened. */
export const canDownload = (): boolean => !!DATA;

let catalogCache: Catalog | null = null;

export async function fetchCatalog(): Promise<Catalog> {
  if (catalogCache) return catalogCache;
  if (!DATA) throw new PackError(t('packs', 'This build has no download address.'));
  const bytes = await fetchBytes(dataUrl('catalog.json'));
  catalogCache = checkCatalog(await toJson(bytes));
  return catalogCache;
}

/* ---------------- installing ---------------- */

async function storeTranslation(value: Translation, origin: PackMeta['origin'], bytes: number): Promise<PackMeta> {
  const meta: PackMeta = {
    id: value.id,
    kind: 'translation',
    name: value.name,
    shortName: value.shortName,
    linkName: value.linkName,
    lang: value.lang,
    version: value.version,
    bytes,
    origin,
    installedAt: new Date().toISOString(),
  };
  await put('packs', { id: value.id, meta, data: value } satisfies PackRecord);
  translations.set(value.id, value);
  installed = [...installed.filter((p) => p.id !== value.id), meta];
  changed();
  return meta;
}

/** Entries of a one-file commentary, split per book; noncanonical references are dropped. */
function splitByBook(entries: CommentaryEntry[]): Map<BookId, CommentaryEntry[]> {
  const byBook = new Map<BookId, CommentaryEntry[]>();
  for (const entry of entries) {
    const range = parseRange(entry.ref);
    if (!range) continue;
    const book = range.from.split('.')[0]!;
    if (!isCanonicalBook(book)) continue;
    const list = byBook.get(book) ?? [];
    list.push(entry);
    byBook.set(book, list);
  }
  return byBook;
}

async function storeCommentaryFile(value: Commentary, bytes: number): Promise<PackMeta> {
  if (!value.entries) throw new PackError(t('packs', 'This commentary is split into many files: download it from the catalog.'));
  const meta: PackMeta = { id: value.id, kind: 'commentary', name: value.name, lang: value.lang, version: value.version, bytes, origin: 'file', installedAt: new Date().toISOString(), ...(value.versification ? { versification: value.versification } : {}) };
  await deletePrefix('commentaryBooks', `${value.id}/`);
  await putMany('commentaryBooks', [...splitByBook(value.entries)].map(([book, entries]) => ({ key: `${value.id}/${book}`, value: entries })));
  await put('packs', { id: value.id, meta } satisfies PackRecord);
  installed = [...installed.filter((p) => p.id !== value.id), meta];
  changed();
  return meta;
}

export async function installCatalogTranslation(entry: CatalogTranslation, onProgress?: Progress): Promise<PackMeta> {
  const bytes = await fetchBytes(dataUrl(entry.url), onProgress, entry.bytes);
  if (entry.sha256 && (await sha256(bytes)) !== entry.sha256) throw new PackError(t('packs', 'The download is damaged. Try again.'));
  const file = identify(await toJson(bytes));
  if (file.kind !== 'translation') throw new PackError(t('pack', 'The file is not a translation or a commentary.'));
  const meta = await storeTranslation(file.value, 'catalog', bytes.length);
  void persist();
  return meta;
}

export async function installCatalogCommentary(entry: CatalogCommentary, all: boolean, onProgress?: Progress): Promise<PackMeta> {
  const manifestUrl = dataUrl(entry.manifest);
  const manifest = checkCommentary(await toJson(await fetchBytes(manifestUrl)));
  const baseUrl = new URL('.', manifestUrl).href;
  if (manifest.entries) {
    // A small one, all in the manifest.
    const meta = await storeCommentaryFile(manifest, entry.bytes);
    await put('packs', { id: meta.id, meta: { ...meta, origin: 'catalog' } } satisfies PackRecord);
    installed = installed.map((p) => (p.id === meta.id ? { ...p, origin: 'catalog' } : p));
    return meta;
  }
  const books = manifest.books ?? [];
  const meta: PackMeta = {
    id: manifest.id,
    kind: 'commentary',
    name: manifest.name,
    lang: manifest.lang,
    version: manifest.version,
    bytes: books.reduce((sum, b) => sum + b.bytes, 0),
    origin: 'catalog',
    installedAt: new Date().toISOString(),
    baseUrl,
    books,
    ...(manifest.versification ? { versification: manifest.versification } : {}),
  };
  await deletePrefix('commentaryBooks', `${manifest.id}/`);
  if (all) {
    let done = 0;
    for (const book of books) {
      await downloadCommentaryBook(meta, book.id, (loaded) => onProgress?.(done + loaded, meta.bytes));
      done += book.bytes;
    }
  }
  await put('packs', { id: meta.id, meta } satisfies PackRecord);
  installed = [...installed.filter((p) => p.id !== meta.id), meta];
  changed();
  void persist();
  return meta;
}

async function downloadCommentaryBook(meta: PackMeta, book: BookId, onProgress?: Progress): Promise<CommentaryEntry[]> {
  const file = meta.books?.find((b) => b.id === book);
  if (!file || !meta.baseUrl) return [];
  const bytes = await fetchBytes(new URL(file.url, meta.baseUrl).href, onProgress, file.bytes);
  if (file.sha256 && (await sha256(bytes)) !== file.sha256) throw new PackError(t('packs', 'The download is damaged. Try again.'));
  const value = checkCommentaryBook(await toJson(bytes));
  const entries = value.entries.filter((e) => parseRange(e.ref)?.from.startsWith(`${book}.`));
  await put('commentaryBooks', entries, `${meta.id}/${book}`);
  return entries;
}

/** A book's entries of a commentary; downloaded now if it loads on demand and we are online. */
export async function commentaryBook(id: string, book: BookId): Promise<CommentaryEntry[]> {
  const stored = await get<CommentaryEntry[]>('commentaryBooks', `${id}/${book}`);
  if (stored) return stored;
  const meta = packMeta(id);
  if (!meta?.books || !navigator.onLine) return [];
  try {
    return await downloadCommentaryBook(meta, book);
  } catch {
    return [];
  }
}

/** A file the user opened or dropped: a translation or a one-file commentary. */
export async function installFile(file: File): Promise<PackMeta> {
  if (file.size > 80 * 1024 * 1024) throw new PackError(t('packs', 'The file is too big.'));
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = identify(await toJson(bytes));
  let meta: PackMeta;
  if (parsed.kind === 'translation') meta = await storeTranslation(parsed.value, 'file', bytes.length);
  else if (parsed.kind === 'commentary') meta = await storeCommentaryFile(parsed.value, bytes.length);
  else throw new PackError(t('pack', 'The file is not a translation or a commentary.'));
  void persist();
  return meta;
}

export async function removePack(id: string): Promise<void> {
  await del('packs', id);
  await deletePrefix('commentaryBooks', `${id}/`);
  translations.delete(id);
  installed = installed.filter((p) => p.id !== id);
  changed();
}

/** Catalog entries newer than what is installed. */
export function hasUpdate(meta: PackMeta, catalog: Catalog | null): boolean {
  if (!catalog || meta.origin !== 'catalog') return false;
  const entry = meta.kind === 'translation' ? catalog.translations.find((e) => e.id === meta.id) : catalog.commentaries.find((e) => e.id === meta.id);
  return !!entry && entry.version !== meta.version;
}

export function cachedCatalog(): Catalog | null {
  return catalogCache;
}
