import { Database } from 'bun:sqlite';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { hashUrl } from '@hn-sidecar/shared';
import { ingest } from './ingest.ts';
import type { Env } from './env.ts';

const schema = await Bun.file(new URL('../../../db/schema.sql', import.meta.url)).text();

const fixture = (beforePut?: (key: string) => void | Promise<void>) => {
  const db = new Database(':memory:');
  db.exec(schema);
  db.run("INSERT INTO meta VALUES ('last_max_item', '1000')");
  const artifacts = new Map<string, any>();
  const batches: number[] = [];
  const prepare = (sql: string) => {
    let values: any[] = [];
    const statement = {
      bind(...args: any[]) {
        expect(args.length).toBeLessThanOrEqual(100);
        values = args;
        return statement;
      },
      async first() { return db.query(sql).get(...values); },
      async all() { return { results: db.query(sql).all(...values) }; },
      run() { return db.query(sql).run(...values); },
      batchResult() { return { results: db.query(sql).all(...values) }; },
    };
    return statement;
  };
  const env = {
    DB: { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
      batches.push(statements.length);
      return db.transaction(() => statements.map(statement => statement.batchResult()))();
    } },
    INDEX: { async head() { return null; }, async put(key: string, body: string) { await beforePut?.(key); artifacts.set(key, JSON.parse(body)); } },
  } as unknown as Env;
  return { db, artifacts, batches, env };
};

const story = (id: number) => ({ id, type: 'story', title: `Story ${id}`, url: `https://example.org/${id}`,
  time: Math.floor(Date.now() / 1000), score: 30, descendants: 12 });

test('latest and front-page stories publish during catch-up without skipping the historical cursor', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  const fetched: number[] = [];
  // Include a story in the rolling refresh and both live feeds to exercise deduplication.
  f.db.run('INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [20001, 'https://example.org/20001', 'Old title', 'author', 1, 0, 1, 0]);
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/maxitem.json')) return Response.json(30000);
    if (url.endsWith('/updates.json')) return Response.json({ items: [20001] });
    if (url.endsWith('/newstories.json')) return Response.json(Array.from({ length: 150 }, (_, i) => 20001 + i));
    if (url.endsWith('/topstories.json')) return Response.json([20001, 25000]);
    const id = Number(url.match(/item\/(\d+)/)?.[1]);
    fetched.push(id);
    // Historical IDs are comments, so only the live pass can find these stories.
    return Response.json(id < 20000 ? { id, type: 'comment' } : story(id));
  }) as typeof fetch;
  try {
    const result = await ingest(f.env);
    expect(result.watermark).toBe(3500);
    expect(f.db.query("SELECT value FROM meta WHERE key = 'last_max_item'").get()).toEqual({ value: '3500' });
    expect(result.stories_upserted).toBe(101);
    expect(fetched.filter((id) => id === 20001)).toHaveLength(1);
    expect(fetched).not.toContain(20101); // cap each feed at 100
    for (const id of [20001, 20100, 25000]) {
      const hash = (await hashUrl(story(id).url))!;
      expect(f.artifacts.get('recent.json').entries).toContainEqual(expect.objectContaining({ id, h: hash.h, c: 12 }));
      expect(f.artifacts.get(`b/${hash.shard}.json`).e).toContainEqual(expect.objectContaining({ id, h: hash.h }));
    }
    expect([...f.artifacts.keys()].slice(-2)).toEqual(['recent.json', 'manifest.json']);
    expect(Math.max(...f.batches)).toBeLessThanOrEqual(100);
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
});

test('upstream item failure never advances the cursor or publishes a partial recent index', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/maxitem.json')) return Response.json(1001);
    if (url.endsWith('/updates.json')) return Response.json({ items: [] });
    if (url.endsWith('stories.json')) return Response.json([]);
    return new Response('unavailable', { status: 503 });
  }) as typeof fetch;
  try {
    await expect(ingest(f.env)).rejects.toThrow('All Firebase item requests failed');
    expect(f.db.query("SELECT value FROM meta WHERE key = 'last_max_item'").get()).toEqual({ value: '1000' });
    expect(f.artifacts.size).toBe(0);
    expect(f.batches).toHaveLength(0);
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
});

test('a timed-out item survives cursor advancement and is published on a later tick', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  let timeout = true;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/maxitem.json')) return Response.json(1002);
    if (url.endsWith('/updates.json')) return Response.json({ items: [] });
    if (url.endsWith('stories.json')) return Response.json([]);
    const id = Number(url.match(/item\/(\d+)/)?.[1]);
    if (id === 1001 && timeout) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('deadline', 'TimeoutError');
    }
    return Response.json(story(id));
  }) as typeof fetch;
  try {
    const first = await ingest(f.env);
    expect(first.watermark).toBe(1002);
    expect(first.items_deferred).toBe(1);
    expect(f.db.query('SELECT id FROM item_retries').all()).toEqual([{ id: 1001 }]);
    expect(f.db.query('SELECT id FROM stories').all()).toEqual([{ id: 1002 }]);
    f.db.exec('UPDATE item_retries SET retry_after=0');
    timeout = false;
    await ingest(f.env);
    expect(f.artifacts.get('recent.json').entries.map((e: {id: number}) => e.id)).toContain(1001);
    expect(f.db.query('SELECT id FROM item_retries').all()).toEqual([]);
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFirebase(max: number, item: (id: number) => Response, feed: number[] = []) {
  const calls: number[] = [];
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/maxitem.json')) return Response.json(max);
    if (path.endsWith('/updates.json')) return Response.json({ items: [] });
    if (path.endsWith('stories.json')) return Response.json(feed);
    const id = Number(path.match(/item\/(\d+)/)?.[1]);
    calls.push(id);
    return item(id);
  }) as typeof fetch;
  return calls;
}

const unavailable = () => new Response(null, { status: 503 });

test('isolated poison retries double their delay until eviction, including retry-only ticks', async () => {
  const f = fixture();
  let seconds = 2_000_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => seconds * 1000);
  try {
    stubFirebase(1002, id => id === 1001 ? unavailable() : Response.json(null));
    for (let attempt = 1; attempt < 8; attempt++) {
      if (attempt === 1) await ingest(f.env);
      else await expect(ingest(f.env)).rejects.toThrow('All Firebase item requests failed');
      const next = seconds + 600 * 2 ** (attempt - 1);
      expect(f.db.query('SELECT retry_after FROM item_retries WHERE id=1001').get()).toEqual({ retry_after: next });
      seconds = next;
    }
    await expect(ingest(f.env)).rejects.toThrow('All Firebase item requests failed');
    expect(f.db.query('SELECT * FROM item_retries').all()).toEqual([]);
  } finally { clock.mockRestore(); f.db.close(); }
});

test('a newly missed high ID gets served ahead of a full batch of older poison IDs', async () => {
  const f = fixture();
  try {
    for (let id = 1; id <= 101; id++)
      f.db.run('INSERT INTO item_retries (id, retry_after) VALUES (?, 0)', [id]);
    const calls = stubFirebase(1000, id => id === 101 ? Response.json(story(id)) : unavailable());
    await ingest(f.env);
    expect(calls).toContain(101);
    expect(f.db.query('SELECT id FROM stories WHERE id=101').get()).toEqual({ id: 101 });
  } finally { f.db.close(); }
});

test('a 95% outage stops requests and holds the historical cursor', async () => {
  const f = fixture();
  try {
    const calls = stubFirebase(3500, id => id % 20 === 0 ? Response.json(null) : unavailable());
    await ingest(f.env);
    expect(calls.length).toBeGreaterThanOrEqual(20);
    expect(calls.length).toBeLessThanOrEqual(50);
    expect(f.db.query("SELECT value FROM meta WHERE key='last_max_item'").get()).toEqual({ value: '1000' });
    expect(f.db.query('SELECT count(*) AS n FROM item_retries').get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test('the fetch deadline leaves unexamined historical IDs for the next tick', async () => {
  const f = fixture();
  let millis = 2_000_000_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => millis);
  try {
    const calls = stubFirebase(3500, () => { millis += 2000; return Response.json(null); });
    const result = await ingest(f.env);
    expect(calls.length).toBeLessThanOrEqual(50);
    expect(result.watermark).toBe(1000 + calls.length);
  } finally { clock.mockRestore(); f.db.close(); }
});

test('failed stale refreshes rotate while a missed new story gets the retry slot', async () => {
  const f = fixture();
  try {
    for (let id = 1; id <= 201; id++)
      f.db.run('INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, 'https://old.test', 'Old', '', 1, 0, id, 0]);
    const calls = stubFirebase(1002, id => id === 1 || id === 1001 ? unavailable() : Response.json(null));
    await ingest(f.env);
    expect(calls).toContain(1);
    expect(f.db.query('SELECT id FROM item_retries').all()).toEqual([{ id: 1001 }]);
    expect(f.db.query('SELECT id FROM stories ORDER BY refreshed_at, ts LIMIT 1').get()).toEqual({ id: 201 });
    f.db.run('UPDATE item_retries SET retry_after=0');
    stubFirebase(1002, id => id === 1001 ? Response.json(story(id)) : unavailable());
    await ingest(f.env);
    expect(f.db.query('SELECT id FROM stories WHERE id=1001').get()).toEqual({ id: 1001 });
  } finally { f.db.close(); }
});

test('a successful stale or feed fetch clears even a future retry', async () => {
  const f = fixture();
  try {
    f.db.run("INSERT INTO stories VALUES (1, 'https://old.test', 'Old', '', 1, 0, 1, 0)");
    for (const id of [1, 2, 3])
      f.db.run('INSERT INTO item_retries (id, retry_after) VALUES (?, 4000000000)', [id]);
    stubFirebase(1000, id => Response.json(id === 1 ? null : id === 2 ? { deleted: true } : story(id)), [2, 3]);
    await ingest(f.env);
    expect(f.db.query('SELECT id FROM item_retries').all()).toEqual([]);
  } finally { f.db.close(); }
});

test('a partial R2 outage during stale URL retarget recovers old and new shards on an unchanged tick', async () => {
  const failKeys = new Set<string>();
  const f = fixture(key => { if (failKeys.has(key)) throw new Error('R2 unavailable'); });
  try {
    let url = 'https://old.test/story';
    let otherScore = 5;
    stubFirebase(1002, id => Response.json(id === 1001 ? { ...story(id), url } : { ...story(id), score: otherScore }));
    await ingest(f.env);
    otherScore++;
    const oldKey = 'b/' + (await hashUrl(url))!.shard + '.json';
    expect(f.artifacts.get(oldKey).e).toContainEqual(expect.objectContaining({ id: 1001 }));
    url = 'https://new.test/story';
    const newKey = 'b/' + (await hashUrl(url))!.shard + '.json';
    expect(newKey).not.toBe(oldKey);
    failKeys.add(oldKey);
    failKeys.add(newKey);
    await expect(ingest(f.env)).rejects.toThrow('R2 unavailable');
    expect(f.db.query('SELECT url FROM stories WHERE id=1001').get()).toEqual({ url });
    const otherKey = 'b/' + (await hashUrl(story(1002).url))!.shard + '.json';
    expect(f.artifacts.get(otherKey).e).toContainEqual(expect.objectContaining({ id: 1002, p: otherScore }));
    failKeys.clear();
    const next = await ingest(f.env);
    expect(next.stories_upserted).toBe(0);
    expect(f.artifacts.get(oldKey).e).toEqual([]);
    expect(f.artifacts.get(newKey).e).toContainEqual(expect.objectContaining({ id: 1001 }));
    expect(f.db.query('SELECT * FROM dirty_shards').all()).toEqual([]);
  } finally { f.db.close(); }
});

test('an overlapping ingest cannot overwrite a newer shard after a slow R2 put', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const writing = new Promise<void>(resolve => { reached = resolve; });
  let block = true;
  const f = fixture(async key => {
    if (block && key.startsWith('b/')) {
      block = false;
      reached();
      await gate;
    }
  });
  let score = 5;
  stubFirebase(1001, id => Response.json({ ...story(id), score }));
  const first = ingest(f.env);
  try {
    await writing;
    score = 10;
    await expect(ingest(f.env)).rejects.toThrow('Ingest already running');
    release();
    await first;
    await ingest(f.env);
    const hash = (await hashUrl(story(1001).url))!;
    expect(f.artifacts.get('b/' + hash.shard + '.json').e).toContainEqual(expect.objectContaining({ p: 10 }));
  } finally { release(); await first; f.db.close(); }
});

test('a 125-story catch-up republishes old buckets within D1 limits before advancing', async () => {
  const f = fixture(() => {
    expect(f.db.query("SELECT value FROM meta WHERE key='last_max_item'").get()).toEqual({ value: '1000' });
  });
  try {
    for (let id = 1001; id <= 1125; id++) {
      f.db.run("INSERT INTO stories VALUES (?, 'https://old.test/story', 'Old', '', 1, 0, 1, 0)", [id]);
      f.db.run("INSERT INTO story_hashes VALUES (?, 'old', 42)", [id]);
    }
    stubFirebase(1125, id => Response.json(story(id)));
    const result = await ingest(f.env);
    expect(result.watermark).toBe(1125);
    expect(result.stories_upserted).toBe(125);
    expect(f.artifacts.get('b/002a.json').e).toEqual([]);
    expect([...f.artifacts.keys()].slice(-2)).toEqual(['recent.json', 'manifest.json']);
    expect(Math.max(...f.batches)).toBeLessThanOrEqual(100);
  } finally { f.db.close(); }
});

test('sparse historical misses cannot exceed retry drain capacity in one catch-up', async () => {
  const f = fixture();
  try {
    const calls = stubFirebase(3500, id => id % 10 === 0 ? unavailable() : Response.json(null));
    const result = await ingest(f.env);
    expect(calls.length).toBeLessThan(600);
    expect(result.watermark).toBe(1000);
    expect(f.db.query('SELECT id FROM item_retries').all()).toEqual([]);
  } finally { f.db.close(); }
});

test('a feed disappearance after a breaker trip preserves undispatched IDs and their first attempt', async () => {
  const f = fixture();
  try {
    const feed = Array.from({ length: 30 }, (_, i) => i + 1);
    const calls = stubFirebase(1000, unavailable, feed);
    await expect(ingest(f.env)).rejects.toThrow('All Firebase item requests failed');
    expect(calls).toHaveLength(25);
    expect(f.db.query('SELECT attempts FROM item_retries WHERE id=30').get()).toEqual({ attempts: 0 });
    stubFirebase(1000, id => Response.json(story(id)));
    await ingest(f.env);
    expect(f.db.query('SELECT id FROM stories WHERE id=30').get()).toEqual({ id: 30 });
    expect(f.db.query('SELECT id FROM item_retries WHERE id=30').get()).toBeNull();
  } finally { f.db.close(); }
});
