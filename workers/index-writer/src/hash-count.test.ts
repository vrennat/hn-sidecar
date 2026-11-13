import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import handler from './index.ts';
import { ingest } from './ingest.ts';
import type { Env } from './env.ts';

const schema = await Bun.file(new URL('../../../db/schema.sql', import.meta.url)).text();

/** A D1 stand-in over real SQLite that runs each batch as one transaction, as D1 does. */
const fixture = () => {
  const db = new Database(':memory:');
  db.exec(schema);
  db.run("INSERT INTO meta VALUES ('last_max_item', '1000')");
  const artifacts = new Map<string, any>();
  const queries: string[] = [];
  const prepare = (sql: string) => {
    queries.push(sql);
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
      runSync() { return db.query(sql).run(...values); },
    };
    return statement;
  };
  const env = {
    DB: { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
      db.transaction(() => { for (const statement of statements) statement.runSync(); })();
    } },
    INDEX: { async put(key: string, body: string) { artifacts.set(key, JSON.parse(body)); } },
    ADMIN_TOKEN: 'test-token',
  } as unknown as Env;
  const actual = () => (db.query('SELECT count(*) AS n FROM story_hashes').get() as { n: number }).n;
  const counter = () => (db.query("SELECT value FROM meta WHERE key = 'story_hashes_count'").get() as { value: string } | null)?.value;
  return { db, artifacts, queries, env, actual, counter };
};

const isFullCount = (sql: string) => /count\(\*\)\s+(AS\s+\w+\s+)?FROM story_hashes\s*$/i.test(sql.trim())
  || /SELECT \?1, count\(\*\) FROM story_hashes$/.test(sql.trim());

const now = () => Math.floor(Date.now() / 1000);

/** Firebase stub: new ids 1001..maxItem are stories; `urls` overrides a story's URL. */
const firebase = (maxItem: number, urls: Map<number, string>, updates: number[] = []) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/maxitem.json')) return Response.json(maxItem);
    if (url.endsWith('/updates.json')) return Response.json({ items: updates });
    if (url.endsWith('stories.json')) return Response.json([]);
    const id = Number(url.match(/item\/(\d+)/)?.[1]);
    return Response.json({ id, type: 'story', title: `Story ${id}`, url: urls.get(id) ?? `https://example.org/${id}`,
      time: now(), score: 5, descendants: 1 });
  }) as typeof fetch;

test('steady-state ingest keeps entry_count exact without scanning story_hashes', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  try {
    // Pre-existing rows the counter already reflects.
    f.db.run("INSERT INTO stories VALUES (5, 'https://example.org/5', 'Five', 'a', 1, 0, ?, ?)", [now(), now()]);
    f.db.run("INSERT INTO story_hashes VALUES (5, 'old', 7)");
    f.db.run("INSERT INTO meta VALUES ('story_hashes_count', '1')");

    globalThis.fetch = firebase(1040, new Map());
    await ingest(f.env);
    expect(f.queries.filter(isFullCount)).toEqual([]);
    expect(f.actual()).toBeGreaterThan(40);
    expect(f.counter()).toBe(String(f.actual()));
    expect(f.artifacts.get('manifest.json').entry_count).toBe(f.actual());

    // A retargeted URL deletes and reinserts that story's rows; a www variant URL changes the row count.
    f.queries.length = 0;
    globalThis.fetch = firebase(1040, new Map([[1001, 'https://www.example.com/a?x=1'], [5, 'https://example.net/5']]), [1001, 5]);
    await ingest(f.env);
    expect(f.queries.filter(isFullCount)).toEqual([]);
    expect(f.counter()).toBe(String(f.actual()));
    expect(f.artifacts.get('manifest.json').entry_count).toBe(f.actual());
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
});

test('a missing counter is seeded by one recount, then maintained', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  try {
    f.db.run("INSERT INTO stories VALUES (5, 'https://example.org/5', 'Five', 'a', 1, 0, ?, ?)", [now(), now()]);
    f.db.run("INSERT INTO story_hashes VALUES (5, 'a', 7), (5, 'b', 8)");
    globalThis.fetch = firebase(1010, new Map());
    await ingest(f.env);
    expect(f.queries.filter(isFullCount)).toHaveLength(1);
    expect(f.counter()).toBe(String(f.actual()));
    expect(f.artifacts.get('manifest.json').entry_count).toBe(f.actual());

    f.queries.length = 0;
    globalThis.fetch = firebase(1020, new Map());
    await ingest(f.env);
    expect(f.queries.filter(isFullCount)).toEqual([]);
    expect(f.counter()).toBe(String(f.actual()));
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
});

test('finalize recounts and resets a drifted counter', async () => {
  const f = fixture();
  try {
    f.db.run("INSERT INTO story_hashes VALUES (1, 'a', 1), (2, 'b', 2), (3, 'c', 3)");
    f.db.run("INSERT INTO meta VALUES ('story_hashes_count', '999')");
    const response = await handler.fetch(
      new Request('https://writer.test/regen/finalize', { method: 'POST', headers: { authorization: 'Bearer test-token' } }),
      f.env,
    );
    expect(await response.json()).toEqual({ finalized: true, entry_count: 3, shard_count: 16384 });
    expect(f.counter()).toBe('3');
    expect(f.artifacts.get('manifest.json').entry_count).toBe(3);
  } finally { f.db.close(); }
});
