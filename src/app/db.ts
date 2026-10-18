/**
 * IndexedDB, promised. One database:
 *   packs            — installed translations and commentaries: { id, meta, data }
 *   commentaryBooks  — a commentary's entries per book: key "<packId>/<BOOK>"
 *   myComments       — the user's own comments, index "book"
 *   cache            — small things worth keeping offline (verse tags of discussions)
 *   auth             — the refresh token
 */

const NAME = 'html-bible';
const VERSION = 1;

let opening: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('commentaryBooks')) db.createObjectStore('commentaryBooks');
      if (!db.objectStoreNames.contains('myComments')) db.createObjectStore('myComments', { keyPath: 'id' }).createIndex('book', 'book');
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
      if (!db.objectStoreNames.contains('auth')) db.createObjectStore('auth');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  return opening;
}

export type StoreName = 'packs' | 'commentaryBooks' | 'myComments' | 'cache' | 'auth';

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export async function get<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return done((await store(name, 'readonly')).get(key)) as Promise<T | undefined>;
}

export async function getAll<T>(name: StoreName): Promise<T[]> {
  return done((await store(name, 'readonly')).getAll()) as Promise<T[]>;
}

export async function getAllByIndex<T>(name: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
  return done((await store(name, 'readonly')).index(index).getAll(key)) as Promise<T[]>;
}

export async function put(name: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  await done((await store(name, 'readwrite')).put(value, key));
}

export async function del(name: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
  await done((await store(name, 'readwrite')).delete(key));
}

/** Several writes in one transaction: all or nothing. */
export async function putMany(name: StoreName, items: { key?: IDBValidKey; value: unknown }[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const item of items) item.key === undefined ? s.put(item.value) : s.put(item.value, item.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Aborted'));
  });
}

/** Keys of a store starting with a prefix ("<packId>/"). */
export async function deletePrefix(name: StoreName, prefix: string): Promise<void> {
  await del(name, IDBKeyRange.bound(prefix, `${prefix}￿`));
}

/** Ask the browser not to clear the downloads when space runs low. Firefox asks the user — so only after a user's action. */
export async function persist(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Not supported: the data stays, only without the promise.
  }
}
