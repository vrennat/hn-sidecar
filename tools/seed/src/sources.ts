/**
 * The two seed backends, behind one keyset-paginated interface.
 *
 * `clickhouse` is the fast path: ~135 queries for a 2-year seed. The source experiment verified its
 * raw `url` text is byte-identical to Firebase's for the same ids, so the two are
 * interchangeable as far as hashing is concerned.
 *
 * `firebase` is the official API and the only option for anything the bulk copy
 * does not have. It has no range query, so seeding through it means walking every
 * item id in the window — ~8.0M ids for 2 years to find ~605K stories. That is
 * hours, not the ~30 min the plan estimated.
 */

export interface SeedStory {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly by: string;
  readonly score: number;
  readonly descendants: number;
  readonly ts: number;
}

export interface SeedPage {
  readonly stories: readonly SeedStory[];
  /** Where the next call should resume. Advances even when `stories` is empty. */
  readonly nextCursor: number;
  readonly done: boolean;
}

export interface SeedSource {
  readonly name: 'clickhouse' | 'firebase';
  /**
   * Stories with id > cursor, ascending. `stories` being empty does NOT mean the
   * range is exhausted — a Firebase id block can legitimately contain no stories
   * at all. Only `done` means exhausted.
   */
  readonly page: (cursor: number, maxId: number) => Promise<SeedPage>;
}

const CLICKHOUSE = 'https://sql-clickhouse.clickhouse.com/?user=demo&default_format=JSONEachRow';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

const retry = async <T>(label: string, attempt: () => Promise<T>, tries = 4): Promise<T> => {
  let lastError: unknown;
  for (let index = 0; index < tries; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      // Exponential backoff for any elevated error rate.
      await Bun.sleep(500 * 2 ** index);
    }
  }
  throw new Error(`${label} failed after ${tries} attempts: ${String(lastError)}`);
};

export const clickhouseSource: SeedSource = {
  name: 'clickhouse',
  page: async (cursor, maxId) =>
    retry('clickhouse page', async () => {
      const sql = `SELECT id, url, title, by, score, descendants, toUnixTimestamp(time) AS ts
        FROM hackernews.hackernews
        WHERE type = 'story' AND url != '' AND id > ${cursor} AND id <= ${maxId}
        ORDER BY id LIMIT 200000`;
      const response = await fetch(CLICKHOUSE, {
        method: 'POST',
        body: sql,
        signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${text.slice(0, 200)}`);
      const stories = text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SeedStory);
      const last = stories[stories.length - 1];
      return {
        stories,
        nextCursor: last?.id ?? cursor,
        // The result is capped by response size, not by LIMIT, so the only
        // reliable exhaustion signal is an empty page.
        done: stories.length === 0,
      };
    }),
};

interface FirebaseItem {
  readonly id?: number;
  readonly type?: string;
  readonly url?: string;
  readonly title?: string;
  readonly by?: string;
  readonly score?: number;
  readonly descendants?: number;
  readonly time?: number;
  readonly dead?: boolean;
  readonly deleted?: boolean;
}

export const fetchFirebaseItem = async (id: number): Promise<FirebaseItem | null> =>
  retry(`firebase item ${id}`, async () => {
    const response = await fetch(`${FIREBASE}/item/${id}.json`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as FirebaseItem | null;
  });

/** A story with a usable URL, or null. Shared by the seed crawl and the ingest cron. */
export const toSeedStory = (item: FirebaseItem | null): SeedStory | null => {
  if (item === null) return null;
  if (item.type !== 'story') return null;
  if (item.dead === true || item.deleted === true) return null;
  const { id, url, title, by, time } = item;
  // Firebase returns url: "" for text posts, not an absent field.
  if (id === undefined || url === undefined || url === '' || title === undefined) return null;
  if (time === undefined) return null;
  return {
    id,
    url,
    title,
    by: by ?? '',
    score: item.score ?? 0,
    descendants: item.descendants ?? 0,
    ts: time,
  };
};

/**
 * Firebase has no range query, so a "page" here is a contiguous block of item ids
 * walked at a bounded rate, keeping only the stories. `requestsPerSecond` is the
 * politeness ceiling — 50 is the documented maximum.
 */
export const firebaseSource = (requestsPerSecond: number, blockSize = 2_000): SeedSource => ({
  name: 'firebase',
  page: async (cursor, maxId) => {
    const stories: SeedStory[] = [];
    const from = cursor + 1;
    const to = Math.min(cursor + blockSize, maxId);
    if (from > to) return { stories: [], nextCursor: cursor, done: true };

    const ids = Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
    const concurrency = Math.max(1, Math.min(requestsPerSecond, 50));

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next];
        next += 1;
        if (id === undefined) continue;
        const story = toSeedStory(await fetchFirebaseItem(id));
        if (story !== null) stories.push(story);
        // Rate limiting: each worker waits so that `concurrency` workers together
        // issue about `requestsPerSecond` requests.
        await Bun.sleep((1000 * concurrency) / requestsPerSecond);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    // The walk is id-ordered even though completion is not.
    return {
      stories: stories.sort((left, right) => left.id - right.id),
      nextCursor: to,
      done: to >= maxId,
    };
  },
});
