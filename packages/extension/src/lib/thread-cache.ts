/**
 * IndexedDB cache of thread HTML. This is v2's server-side KV cache moved
 * client-side: cross-user warming is lost, and a service is deleted.
 *
 * It stores the **raw HTML**, not the parsed rows, for two reasons. Parsed rows are DOM
 * nodes and cannot be stored; serializing them would mean writing sanitized markup and
 * then re-trusting our own output on read. Re-parsing is one `DOMParser` pass, which is
 * the same pass a network response pays, so the cache keeps the single-pass invariant
 * intact instead of trading it for a smaller record.
 *
 * `unlimitedStorage` was deliberately dropped from the manifest, so this is bounded by
 * total bytes and evicts least-recently-used. A p99 thread is ~3.5 MB.
 */

const DB_NAME = 'hn-sidecar';
const DB_VERSION = 1;
const STORE = 'threads';
const MAX_BYTES = 40_000_000;

/** Fresh stories still gain comments; old ones are settled. */
const TTL_FRESH_MS = 10 * 60_000;
const TTL_SETTLED_MS = 30 * 24 * 60 * 60_000;
const FRESH_STORY_AGE_MS = 24 * 60 * 60_000;

interface Record_ {
  readonly id: number;
  readonly html: string;
  readonly fetchedAt: number;
  /** Story creation time, unix seconds — decides which TTL applies. */
  readonly storyTs: number;
  readonly bytes: number;
  lastUsed: number;
}

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('lastUsed', 'lastUsed');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  });

const asPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('idb request failed'));
  });

const ttlFor = (storyTs: number): number =>
  Date.now() - storyTs * 1000 < FRESH_STORY_AGE_MS ? TTL_FRESH_MS : TTL_SETTLED_MS;

export const readThread = async (id: number): Promise<string | null> => {
  try {
    const db = await open();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const record = await asPromise<Record_ | undefined>(store.get(id) as IDBRequest<Record_ | undefined>);
    if (record === undefined) return null;
    if (Date.now() - record.fetchedAt > ttlFor(record.storyTs)) {
      store.delete(id);
      return null;
    }
    store.put({ ...record, lastUsed: Date.now() });
    return record.html;
  } catch {
    // A cache that cannot be read is a cache miss, never an error the user sees.
    return null;
  }
};

export const writeThread = async (id: number, html: string, storyTs: number): Promise<void> => {
  try {
    const db = await open();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    store.put({ id, html, fetchedAt: Date.now(), storyTs, bytes: html.length, lastUsed: Date.now() });
    await prune(db);
  } catch {
    // Over quota or blocked: the thread still rendered, it just will not be cached.
  }
};

const prune = async (db: IDBDatabase): Promise<void> => {
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const all = await asPromise<Record_[]>(store.getAll() as IDBRequest<Record_[]>);
  let total = all.reduce((sum, record) => sum + record.bytes, 0);
  if (total <= MAX_BYTES) return;
  for (const record of [...all].sort((left, right) => left.lastUsed - right.lastUsed)) {
    if (total <= MAX_BYTES) break;
    store.delete(record.id);
    total -= record.bytes;
  }
};
