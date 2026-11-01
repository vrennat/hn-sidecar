/** Session-only cache. Hydrate once per worker so eviction includes previous lifetimes. */
interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}
type Storage = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;
const CAPS: Record<string, number> = { 'linkmap:': 400, 'finding:': 64 };
const namespaceOf = (key: string): string => (key.includes(':') ? key.slice(0, key.indexOf(':') + 1) : '');
const fresh = (entry: Entry<unknown> | undefined): boolean => entry !== undefined && entry.expiresAt > Date.now();

export class SessionCache {
  private readonly memory = new Map<string, Entry<unknown>>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: () => Storage = () => chrome.storage.session) {}

  // Serialize hydration and mutations. Concurrent listing writes must share one cap.
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const stored = await this.storage().get(null);
      for (const [key, entry] of Object.entries(stored)) {
        if (entry && typeof entry === 'object' && 'expiresAt' in entry) {
          if (!this.memory.has(key)) this.memory.set(key, entry as Entry<unknown>);
        }
      }
      this.loaded = true;
    } catch {
      /* Unavailable storage is a cache miss; retry hydration next time. */
    }
  }

  private async prune(): Promise<void> {
    const remove: string[] = [];
    const namespaces = new Map<string, string[]>();
    for (const [key, entry] of this.memory) {
      if (!fresh(entry)) {
        remove.push(key);
        continue;
      }
      const namespace = namespaceOf(key);
      const keys = namespaces.get(namespace) ?? [];
      keys.push(key);
      namespaces.set(namespace, keys);
    }
    for (const [namespace, keys] of namespaces) {
      remove.push(...keys.slice(0, Math.max(0, keys.length - (CAPS[namespace] ?? 96))));
    }
    for (const key of remove) this.memory.delete(key);
    if (remove.length)
      await this.storage()
        .remove(remove)
        .catch(() => undefined);
  }

  get<T>(key: string): Promise<T | null> {
    return this.run(async () => {
      await this.load();
      await this.prune();
      return (this.memory.get(key)?.value as T | undefined) ?? null;
    });
  }

  set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    return this.run(async () => {
      await this.load();
      const entry = { value, expiresAt: Date.now() + ttlMs };
      // Refreshing a key also moves it to the back of the eviction queue.
      this.memory.delete(key);
      this.memory.set(key, entry);
      await this.prune();
      await this.storage()
        .set({ [key]: entry })
        .catch(() => undefined);
    });
  }

  delete(key: string): Promise<void> {
    return this.run(async () => {
      await this.load();
      this.memory.delete(key);
      await this.storage()
        .remove(key)
        .catch(() => undefined);
    });
  }
}
const cache = new SessionCache();
export const cacheGet = <T>(key: string): Promise<T | null> => cache.get<T>(key);
export const cacheSet = <T>(key: string, value: T, ttlMs: number): Promise<void> => cache.set(key, value, ttlMs);
export const cacheDelete = (key: string): Promise<void> => cache.delete(key);
