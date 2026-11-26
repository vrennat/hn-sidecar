import type { Env } from './env.ts';

export const RETRY_BATCH = 100;
const RETRY_DELAY_SECONDS = 600;
const MAX_RETRY_ATTEMPTS = 8;
// An equality seek per attempt count lets SQLite skip future deadlines even when
// nothing is due. Within each count, prefer the newest eligible misses.
const attemptCounts = Array.from({ length: MAX_RETRY_ATTEMPTS }, (_, i) => i).join(',');
export const DUE_ITEMS_SQL =
  `SELECT id FROM item_retries WHERE attempts IN (${attemptCounts}) AND retry_after <= ?1
   ORDER BY attempts, retry_after DESC, id DESC LIMIT ?2`;

export async function deferItems(env: Env, now: number, skippedFeeds: number[], deferred: number[]): Promise<void> {
  for (let offset = 0; offset < skippedFeeds.length; offset += RETRY_BATCH) {
    await env.DB.batch(skippedFeeds.slice(offset, offset + RETRY_BATCH).map(id => env.DB.prepare(
      `INSERT OR IGNORE INTO item_retries (id, retry_after, attempts)
       SELECT ?1, ?2, 0 WHERE NOT EXISTS (SELECT 1 FROM stories WHERE id = ?1)`,
    ).bind(id, now)));
  }
  for (let offset = 0; offset < deferred.length; offset += RETRY_BATCH - 1) {
    const part = deferred.slice(offset, offset + RETRY_BATCH - 1);
    const schedule = part.map(id => env.DB.prepare(
      `INSERT INTO item_retries (id, retry_after)
       SELECT ?1, ?2 + ?3 WHERE NOT EXISTS (SELECT 1 FROM stories WHERE id = ?1)
       ON CONFLICT(id) DO UPDATE SET
         attempts = attempts + 1, retry_after = ?2 + (?3 << attempts)
       WHERE retry_after <= ?2`,
    ).bind(id, now, RETRY_DELAY_SECONDS));
    const evict = env.DB.prepare('DELETE FROM item_retries WHERE attempts >= ? RETURNING id')
      .bind(MAX_RETRY_ATTEMPTS);
    const results = await env.DB.batch<{ id: number }>([...schedule, evict]);
    const evicted = results.at(-1)!.results;
    if (evicted.length) console.warn('evicted Firebase item retries', evicted.map(row => row.id));
  }
}
