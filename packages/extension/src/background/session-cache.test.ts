import { expect, test } from 'bun:test';
import { SessionCache } from './session-cache.ts';
const storage = (initial: Record<string, unknown> = {}) => {
  const data = structuredClone(initial);
  let reads = 0;
  return {
    data,
    get reads() {
      return reads;
    },
    async get() {
      reads++;
      return structuredClone(data);
    },
    async set(values: Record<string, unknown>) {
      Object.assign(data, values);
    },
    async remove(keys: string | string[]) {
      for (const key of [keys].flat()) delete data[key];
    },
  };
};
test('restart hydration prunes persisted namespaces, independently, and only reads storage once', async () => {
  const store = storage(
    Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`linkmap:${i}`, { value: i, expiresAt: Date.now() + 60_000 }]),
    ),
  );
  const cache = new SessionCache(() => store as unknown as chrome.storage.StorageArea);
  await cache.set('linkmap:new', 'new', 60_000);
  expect(Object.keys(store.data)).toHaveLength(400);
  expect(store.data['linkmap:0']).toBeUndefined();
  await Promise.all(Array.from({ length: 70 }, (_, i) => cache.set(`finding:${i}`, i, 60_000)));
  expect(Object.keys(store.data).filter((key) => key.startsWith('finding:'))).toHaveLength(64);
  expect(await cache.get<string>('linkmap:new')).toBe('new');
  expect(store.reads).toBe(1);
});
test('expired entries and deleted tab findings cannot reappear from memory or session storage', async () => {
  const store = storage({
    'finding:closed': { value: 'old', expiresAt: Date.now() + 60_000 },
    stale: { value: 'expired', expiresAt: Date.now() - 1 },
  });
  const cache = new SessionCache(() => store as unknown as chrome.storage.StorageArea);
  expect(await cache.get('stale')).toBeNull();
  await cache.delete('finding:closed');
  expect(await cache.get('finding:closed')).toBeNull();
  expect(store.data).toEqual({});
});
test('unavailable storage still serves the in-memory cache', async () => {
  const fail = async () => {
    throw new Error('quota');
  };
  const cache = new SessionCache(
    () => ({ get: fail, set: fail, remove: fail }) as unknown as chrome.storage.StorageArea,
  );
  await cache.set('test', 42, 60_000);
  expect(await cache.get<number>('test')).toBe(42);
});
