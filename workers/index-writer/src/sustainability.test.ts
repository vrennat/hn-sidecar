import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { DUE_ITEMS_SQL } from './item-retries.ts';
import { putShard } from './publish.ts';
import type { Env } from './env.ts';

test('production migrations and fresh schema provide the same tables, indexes, and retry plan', async () => {
  const fresh = new Database(':memory:');
  const migrated = new Database(':memory:');
  try {
    fresh.exec(await Bun.file(new URL('../../../db/schema.sql', import.meta.url)).text());
    // Start from the existing base tables. Each migration must supply its own objects.
    for (const row of fresh.query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_schema WHERE name IN ('meta','stories','stories_ts','stories_refreshed_at','story_hashes')",
    ).all()) migrated.exec(row.sql);
    migrated.exec('CREATE INDEX story_hashes_bucket ON story_hashes (bucket, story_id)');
    const dir = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
      migrated.exec(await Bun.file(new URL(file, dir)).text());
    }
    const objects = (db: Database) => db.query('SELECT name, sql FROM sqlite_schema ORDER BY name').all();
    expect(objects(migrated)).toEqual(objects(fresh));
    const plan = (sql: string) => migrated.query<{ detail: string }, []>('EXPLAIN QUERY PLAN ' + sql)
      .all().map(r => r.detail).join('\n');
    expect(plan('SELECT count(*) AS n FROM story_hashes')).toMatch(/SCAN story_hashes/);
    expect(plan('SELECT value FROM meta WHERE key=?1')).toMatch(/SEARCH meta USING INDEX/);
    expect(plan(DUE_ITEMS_SQL)).toMatch(/SEARCH item_retries USING COVERING INDEX item_retries_due .*attempts=.+retry_after</);
    expect(plan('SELECT id FROM item_retries ORDER BY id+0')).toContain('TEMP B-TREE');
    expect(plan(DUE_ITEMS_SQL)).not.toContain('TEMP B-TREE');
  } finally { fresh.close(); migrated.close(); }
});

test('shards use the SHA-256 of the exact stored body and require a full digest to skip', async () => {
  let checksum: ArrayBuffer | undefined;
  let puts = 0;
  const env = { INDEX: {
    async head() { return { checksums: { sha256: checksum } }; },
    async put(_key: string, body: string, options: {sha256: ArrayBuffer}) {
      const digest = Uint8Array.from(createHash('sha256').update(body).digest());
      expect(new Uint8Array(options.sha256)).toEqual(digest);
      checksum = digest.buffer;
      puts++;
    },
  } } as unknown as Env;
  const row = { id: 1, h: 'hash', t: 'café', p: 2, c: 0, ts: 100 };
  expect(await putShard(env, 1, [row], true)).toBe(true);
  expect(await putShard(env, 1, [row], true)).toBe(false);
  checksum = checksum!.slice(0, 31);
  expect(await putShard(env, 1, [row], true)).toBe(true);
  expect(await putShard(env, 1, [{ ...row, p: 3 }], true)).toBe(true);
  expect(puts).toBe(3);
});
