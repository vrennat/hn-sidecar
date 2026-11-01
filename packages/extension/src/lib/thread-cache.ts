/** Bounded, best-effort HTML cache. Metadata is separate so pruning never loads every body. */
const DB_NAME = 'hn-sidecar';
const DB_VERSION = 2;
const STORE = 'threads';
const META = 'metadata';
const MAX_BYTES = 40_000_000;
const DAY = 24 * 3600_000;
export interface CachedThread {
  readonly html: string;
  readonly fetchedAt: number;
}
interface Record_ extends CachedThread {
  readonly id: number;
  readonly storyTs: number;
  readonly expiresAt?: number;
}
interface Metadata {
  readonly id: number;
  readonly bytes: number;
  readonly lastUsed: number;
}

// Choose freshness when fetched, never when read: crossing midnight cannot extend it.
export const threadExpiresAt = (fetchedAt: number, storyTs: number): number =>
  fetchedAt + (fetchedAt - storyTs * 1000 < DAY ? 10 * 60_000 : 30 * DAY);
const bytesOf = (html: string): number => html.length * 2; // conservative UTF-16 body estimate
const asPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
const completed = (tx: IDBTransaction): Promise<void> => {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
  // A request can reject before its transaction does; both are still observed.
  void done.catch(() => undefined);
  return done;
};
const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('IndexedDB upgrade blocked'));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      const metadata = db.createObjectStore(META, { keyPath: 'id' });
      // Upgrade v1 in the versionchange transaction; HTML never leaves the browser.
      const cursor = request.transaction!.objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const record = current.value as Record_ & { lastUsed?: number };
        metadata.put({ id: record.id, bytes: bytesOf(record.html), lastUsed: record.lastUsed ?? record.fetchedAt });
        current.continue();
      };
    };
    request.onsuccess = () => {
      if (abandoned) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });

export const readThread = async (id: number): Promise<CachedThread | null> => {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    const tx = db.transaction([STORE, META], 'readwrite');
    const done = completed(tx);
    const store = tx.objectStore(STORE);
    const record = await asPromise<Record_ | undefined>(store.get(id));
    const valid = record && Date.now() < (record.expiresAt ?? threadExpiresAt(record.fetchedAt, record.storyTs));
    if (record && !valid) {
      store.delete(id);
      tx.objectStore(META).delete(id);
    }
    if (record && valid) tx.objectStore(META).put({ id, bytes: bytesOf(record.html), lastUsed: Date.now() });
    await done;
    return valid ? { html: record.html, fetchedAt: record.fetchedAt } : null;
  } catch {
    return null;
  } finally {
    // Cache failures never prevent fetching the public thread.
    db?.close();
  }
};

export const writeThread = async (id: number, html: string, storyTs: number, fetchedAt = Date.now()): Promise<void> => {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    const tx = db.transaction([STORE, META], 'readwrite');
    const done = completed(tx);
    const store = tx.objectStore(STORE);
    const metadata = tx.objectStore(META);
    store.put({ id, html, storyTs, fetchedAt, expiresAt: threadExpiresAt(fetchedAt, storyTs) });
    metadata.put({ id, bytes: bytesOf(html), lastUsed: fetchedAt });
    const all = await asPromise<Metadata[]>(metadata.getAll());
    let bytes = all.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of all.sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (bytes <= MAX_BYTES) break;
      store.delete(entry.id);
      metadata.delete(entry.id);
      bytes -= entry.bytes;
    }
    await done;
  } catch {
    /* Quota/blocked storage: the network response is still usable. */
  } finally {
    db?.close();
  }
};
