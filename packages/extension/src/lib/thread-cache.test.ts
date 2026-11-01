import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { readThread, threadExpiresAt, writeThread } from './thread-cache.ts';
const original = globalThis.indexedDB;
let clock: ReturnType<typeof spyOn>;
let now: number;
beforeEach(() => {
  now = 1793550000000;
  clock = spyOn(Date, 'now').mockImplementation(() => now);
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  clock.mockRestore();
  globalThis.indexedDB = original;
});
test('fresh-story expiry stays fixed when the story crosses 24 hours', async () => {
  const storyTs = Math.floor((now - 23.9 * 3600_000) / 1000);
  await writeThread(1, 'fresh', storyTs);
  expect(await readThread(1)).toEqual({ html: 'fresh', fetchedAt: now });
  now += 20 * 60_000;
  expect(await readThread(1)).toBeNull();
});
test('settled stories expire at the fixed 30-day boundary', async () => {
  const fetchedAt = now;
  const storyTs = Math.floor((now - 2 * 24 * 3600_000) / 1000);
  expect(threadExpiresAt(now, storyTs)).toBe(now + 30 * 24 * 3600_000);
  await writeThread(2, 'settled', storyTs);
  now += 30 * 24 * 3600_000 - 1;
  expect(await readThread(2)).toEqual({ html: 'settled', fetchedAt });
  now += 1;
  expect(await readThread(2)).toBeNull();
});
test('v1 migration retains usable HTML and honors its original short TTL', async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('hn-sidecar', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('threads', { keyPath: 'id' });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('threads', 'readwrite');
      tx.objectStore('threads').put({
        id: 3,
        html: 'legacy',
        fetchedAt: now - 20 * 60_000,
        storyTs: Math.floor((now - 24 * 3600_000 - 60_000) / 1000),
        lastUsed: now,
        bytes: 6,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    };
  });
  expect(await readThread(3)).toBeNull();
  await writeThread(4, 'new', Math.floor(now / 1000));
  expect((await readThread(4))?.html).toBe('new');
});
test('metadata-only pruning evicts the least recently used body and permits replacement', async () => {
  const html = 'a'.repeat(10_100_000); // two bodies exceed the 40 MB UTF-16 estimate
  await writeThread(1, html, 1);
  now += 1;
  await writeThread(2, html, 1);
  expect(await readThread(1)).toBeNull();
  expect((await readThread(2))?.html.length).toBe(html.length);
  await writeThread(2, 'replacement', 1);
  expect((await readThread(2))?.html).toBe('replacement');
});
test('failed/blocked cache access is a miss', async () => {
  globalThis.indexedDB = {
    open() {
      throw new Error('blocked');
    },
  } as unknown as IDBFactory;
  expect(await readThread(1)).toBeNull();
  await writeThread(1, 'still usable', 1);
});

test('a blocked v1 upgrade is a prompt cache miss and closes late upgraded connections', async () => {
  const held = await new Promise<IDBDatabase>((resolve) => {
    const req = indexedDB.open('hn-sidecar', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('threads', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
  });
  try {
    expect(await readThread(1)).toBeNull();
  } finally {
    held.close();
  }
  // Let the abandoned open complete. Its connection must not block a later upgrade.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await writeThread(1, 'recovered', 1);
  expect((await readThread(1))?.html).toBe('recovered');
});
