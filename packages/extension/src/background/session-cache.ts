/**
 * A TTL cache that survives service-worker termination.
 *
 * MV3 kills the worker after ~30 s idle, so a plain `Map` is emptied several times
 * an hour during normal browsing. Every miss here is a network request that leaks a
 * little more shard-fetch volume than it needs to, so the cache is mirrored
 * into `chrome.storage.session` — cleared when the browser closes, never written to
 * disk, and not readable by content scripts under the default access level.
 */

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * Bounded per namespace, not globally.
 *
 * One shared cap would let a single HN listing visit evict everything else: the link map
 * writes one key per distinct URL on the page, so ~30 per visit, and two visits plus a
 * re-scrape from the mutation observer would push out cached shards and per-tab findings
 * by insertion order. An evicted finding means the panel re-runs a lookup, which is an
 * avoidable shard fetch — the exact thing §6 wants to keep rare.
 *
 * Sized against `chrome.storage.session`'s 10 MB: shards dominate at ~11 KB each, so the
 * index namespace is the only one that costs anything (~1 MB at cap). Link map entries
 * are a few hundred bytes and findings are smaller.
 */
const CAPS: readonly (readonly [string, number])[] = [
  ['linkmap:', 400],
  ['finding:', 64],
];
const DEFAULT_CAP = 96;

/** Keys are `linkmap:<url>`, `finding:<tabId>`, or a bare artifact path. */
const namespaceOf = (key: string): string => {
  const colon = key.indexOf(':');
  return colon === -1 ? '' : key.slice(0, colon + 1);
};

const capFor = (namespace: string): number =>
  CAPS.find(([prefix]) => prefix === namespace)?.[1] ?? DEFAULT_CAP;

const memory = new Map<string, Entry<unknown>>();

const isFresh = (entry: Entry<unknown> | undefined): boolean =>
  entry !== undefined && entry.expiresAt > Date.now();

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  const local = memory.get(key);
  if (isFresh(local)) return (local as Entry<T>).value;
  memory.delete(key);

  try {
    const stored = await chrome.storage.session.get(key);
    const entry = stored[key] as Entry<T> | undefined;
    if (!isFresh(entry)) {
      if (entry !== undefined) await chrome.storage.session.remove(key);
      return null;
    }
    memory.set(key, entry as Entry<unknown>);
    return (entry as Entry<T>).value;
  } catch {
    // Session storage is a cache, never the authority — a failure here is a miss.
    return null;
  }
};

export const cacheSet = async <T>(key: string, value: T, ttlMs: number): Promise<void> => {
  const entry: Entry<T> = { value, expiresAt: Date.now() + ttlMs };
  memory.set(key, entry as Entry<unknown>);

  // Drop expired entries first; only evict live ones if still over the cap.
  for (const [candidate, existing] of memory) {
    if (!isFresh(existing)) memory.delete(candidate);
  }

  const namespace = namespaceOf(key);
  const cap = capFor(namespace);
  // Map iteration is insertion order, so filtering by namespace gives oldest-first.
  const siblings = [...memory.keys()].filter((candidate) => namespaceOf(candidate) === namespace);
  for (const evicted of siblings.slice(0, Math.max(0, siblings.length - cap))) {
    memory.delete(evicted);
    void chrome.storage.session.remove(evicted);
  }

  try {
    await chrome.storage.session.set({ [key]: entry });
  } catch {
    // Over quota or unavailable: the in-memory copy still serves this worker's life.
  }
};
