/**
 * The manifest's `entry_count`, kept as a counter in `meta` instead of recounted.
 *
 * `SELECT count(*) FROM story_hashes` scans the whole table (~700K rows read), and
 * ingest ran it every tick only to fill a sanity-check field. Ingest now adjusts
 * the counter inside each write batch, so the count stays exact without a scan.
 *
 * Any write to story_hashes that bypasses ingest (the seed import, a manual
 * DELETE) leaves the counter stale until `POST /regen/finalize`, which recounts
 * once and resets it; run finalize after such a write. A missing counter is
 * seeded from a single recount on the next ingest.
 */

import type { Env } from './env.ts';

export const HASH_COUNT_KEY = 'story_hashes_count';

const parseCount = (row: { value: string } | null): number | null => {
  if (row === null) return null;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const readHashCount = async (env: Env): Promise<number | null> =>
  parseCount(await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(HASH_COUNT_KEY).first<{ value: string }>());

/** Full recount in one statement, so no concurrent batch can land between the count and the write. */
export const recountHashes = async (env: Env): Promise<number> => {
  await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) SELECT ?1, count(*) FROM story_hashes')
    .bind(HASH_COUNT_KEY)
    .run();
  return (await readHashCount(env)) ?? 0;
};

/**
 * Wraps a write batch that replaces the hash rows of `storyIds` so the counter moves
 * by exactly the net change. The `-` before and `+` after count only those stories'
 * rows (a primary-key prefix lookup), and D1 runs a batch as one transaction, so the
 * counter cannot drift from a partial batch. Callers keep `storyIds` within D1's
 * bound-parameter limit (one slot goes to the key).
 */
export const withHashCount = (
  env: Env,
  storyIds: readonly number[],
  statements: readonly D1PreparedStatement[],
): D1PreparedStatement[] => {
  if (storyIds.length === 0) return [...statements];
  const ids = [...new Set(storyIds)];
  const inList = ids.map((_, index) => `?${index + 2}`).join(',');
  const adjust = (sign: '+' | '-'): D1PreparedStatement =>
    env.DB.prepare(
      `UPDATE meta SET value = CAST(value AS INTEGER) ${sign} (SELECT count(*) FROM story_hashes WHERE story_id IN (${inList}))
        WHERE key = ?1`,
    ).bind(HASH_COUNT_KEY, ...ids);
  return [adjust('-'), ...statements, adjust('+')];
};
