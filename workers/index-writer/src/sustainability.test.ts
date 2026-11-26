import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { putShard } from './publish.ts';
import type { Env } from './env.ts';

test('a retry lookup seeks the due range and a steady-state count seeks one meta row', async () => {
  const db = new Database(':memory:');
  db.exec(await Bun.file(new URL('../../../db/schema.sql', import.meta.url)).text());
  const plan = (sql: string) => db.query('EXPLAIN QUERY PLAN ' + sql).all().map(r => (r as {detail: string}).detail).join('\n');
  expect(plan('SELECT count(*) AS n FROM story_hashes')).toMatch(/SCAN story_hashes/);
  expect(plan('SELECT value FROM meta WHERE key=?1')).toMatch(/SEARCH meta USING INDEX/);
  expect(plan('SELECT id FROM item_retries WHERE retry_after <= ?1 ORDER BY retry_after, id LIMIT ?2')).toMatch(/SEARCH item_retries USING COVERING INDEX item_retries_due/);
  db.close();
});

test('shard puts skip identical content and update legacy objects and changed scores', async () => {
  let checksum: ArrayBuffer | undefined;
  let puts = 0;
  const env = { INDEX: {
    async head() { return { checksums: { sha256: checksum } }; },
    async put(_key: string, _body: string, options: {sha256: ArrayBuffer}) { puts++; checksum = options.sha256; },
  } } as unknown as Env;
  const row = { id: 1, h: 'hash', t: 'title', p: 2, c: 0, ts: 100 };
  expect(await putShard(env, 1, [row], true)).toBe(true);
  expect(await putShard(env, 1, [row], true)).toBe(false);
  expect(await putShard(env, 1, [{ ...row, p: 3 }], true)).toBe(true);
  expect(puts).toBe(2);
});
