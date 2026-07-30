/**
 * The full-regen batch. D1 → all 16,384 shards → R2.
 *
 * Runs over a bucket range per invocation so the work stays inside the 10,000
 * subrequests-per-invocation limit and inside Worker memory. The caller walks the
 * ranges and then finalizes; see `tools/publish/src/regen.ts`.
 *
 * Every bucket in the range is written, including empty ones. Two reasons: a
 * client always gets a 200 rather than having to treat 404 as "no match", and a
 * 404 on an empty bucket would itself disclose that the bucket is empty.
 */

import { BUCKET_COUNT, type ShardEntry } from '@hn-sidecar/shared';
import type { Env } from './env.ts';
import { putShard } from './publish.ts';

/** Rows per D1 page. Keeps each result well under D1's response size limit. */
const PAGE_SIZE = 5_000;

/**
 * Concurrent R2 puts. Sequential puts over a 4,096-bucket range would be minutes
 * of wall time in pure I/O wait; R2 operations are subrequests, so the cap on the
 * range (not this number) is what keeps the invocation under 10,000.
 */
const PUT_CONCURRENCY = 40;

interface HashRow {
  readonly bucket: number;
  readonly h: string;
  readonly id: number;
  readonly t: string;
  readonly p: number;
  readonly c: number;
  readonly ts: number;
}

export interface RegenResult {
  readonly from: number;
  readonly to: number;
  readonly shards_written: number;
  readonly entries: number;
  /** Milliseconds spent waiting on D1 reads vs R2 writes, to locate a bottleneck. */
  readonly d1_ms: number;
  readonly r2_ms: number;
  readonly d1_pages: number;
}

/**
 * Rewrites shards for buckets in `[from, to)`.
 *
 * Pages by (bucket, story_id, h) keyset rather than LIMIT/OFFSET, so a bucket
 * larger than one page cannot silently lose entries.
 */
export const regenRange = async (env: Env, from: number, to: number): Promise<RegenResult> => {
  const start = Math.max(0, Math.min(from, BUCKET_COUNT));
  const end = Math.max(start, Math.min(to, BUCKET_COUNT));

  let cursorBucket = start;
  let cursorStory = -1;
  let cursorHash = '';
  let entries = 0;
  let shardsWritten = 0;
  let d1Ms = 0;
  let r2Ms = 0;
  let d1Pages = 0;

  // Entries for the bucket currently being accumulated.
  let openBucket = start;
  let open: ShardEntry[] = [];
  let pending: { bucket: number; entries: ShardEntry[] }[] = [];

  const flush = async (): Promise<void> => {
    while (pending.length > 0) {
      const batch = pending.splice(0, PUT_CONCURRENCY);
      const at = Date.now();
      await Promise.all(batch.map((item) => putShard(env, item.bucket, item.entries)));
      r2Ms += Date.now() - at;
      shardsWritten += batch.length;
      for (const item of batch) entries += item.entries.length;
    }
  };

  const closeThrough = async (upTo: number): Promise<void> => {
    // Queue the open bucket and every empty bucket up to (not including) upTo.
    while (openBucket < upTo) {
      pending.push({ bucket: openBucket, entries: open });
      openBucket += 1;
      open = [];
    }
    if (pending.length >= PUT_CONCURRENCY * 4) await flush();
  };

  for (;;) {
    const queryAt = Date.now();
    const page = await env.DB.prepare(
      `SELECT h.bucket AS bucket, h.h AS h, s.id AS id, s.title AS t,
              s.score AS p, s.descendants AS c, s.ts AS ts
         FROM story_hashes h
         JOIN stories s ON s.id = h.story_id
        WHERE h.bucket >= ?1 AND h.bucket < ?2
          AND (h.bucket > ?3 OR (h.bucket = ?3 AND (h.story_id > ?4 OR (h.story_id = ?4 AND h.h > ?5))))
        ORDER BY h.bucket, h.story_id, h.h
        LIMIT ?6`,
    )
      .bind(start, end, cursorBucket, cursorStory, cursorHash, PAGE_SIZE)
      .all<HashRow>();
    d1Ms += Date.now() - queryAt;
    d1Pages += 1;

    const rows = page.results;
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.bucket !== openBucket) {
        await closeThrough(row.bucket);
      }
      open.push({ h: row.h, id: row.id, t: row.t, p: row.p, c: row.c, ts: row.ts });
    }

    const last = rows[rows.length - 1];
    if (last === undefined) break;
    cursorBucket = last.bucket;
    cursorStory = last.id;
    cursorHash = last.h;
    if (rows.length < PAGE_SIZE) break;
  }

  // Flush the final open bucket and pad out the rest of the range with empties.
  await closeThrough(end);
  await flush();

  return { from: start, to: end, shards_written: shardsWritten, entries, d1_ms: d1Ms, r2_ms: r2Ms, d1_pages: d1Pages };
};
