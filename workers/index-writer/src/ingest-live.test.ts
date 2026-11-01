import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { hashUrl } from '@hn-sidecar/shared';
import { ingest } from './ingest.ts';
import type { Env } from './env.ts';

const schema = await Bun.file(new URL('../../../db/schema.sql', import.meta.url)).text();

const fixture = () => {
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
      async run() { return db.query(sql).run(...values); },
    };
    return statement;
  };
  const env = {
    DB: { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
      batches.push(statements.length);
      for (const statement of statements) await statement.run();
    } },
    INDEX: { async put(key: string, body: string) { artifacts.set(key, JSON.parse(body)); } },
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
    expect(f.db.query('SELECT value FROM meta').get()).toEqual({ value: '3500' });
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
    await expect(ingest(f.env)).rejects.toThrow('503');
    expect(f.db.query('SELECT value FROM meta').get()).toEqual({ value: '1000' });
    expect(f.artifacts.size).toBe(0);
    expect(f.batches).toHaveLength(0);
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
});
