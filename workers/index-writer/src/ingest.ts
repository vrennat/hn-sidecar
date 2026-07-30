/**
 * Ingest cron, every 10 minutes.
 *
 * Polls Firebase for changed items and the maxitem watermark, upserts into D1,
 * rewrites only the touched shards, then rewrites `recent.json`. Everything is
 * idempotent: a failed run is simply retried by the next tick, and a partially
 * applied run leaves D1 and the shards consistent because shards are always
 * derived from D1 rather than patched.
 */

import { BUCKET_COUNT, hashNormalized, urlVariants, type ShardEntry } from '@hn-sidecar/shared';
import type { Env } from './env.ts';
import { putManifest, putRecent, putShard } from './publish.ts';

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

/** Watermark key in `meta`. */
const WATERMARK = 'last_max_item';

/**
 * Cap on new ids examined per run. HN produces ~11K items/day (~76 per 10 min), so
 * this is ~5 h of catch-up headroom. Sized to leave subrequest room for the shard
 * rewrites a large catch-up implies (each touched bucket costs a D1 read plus an
 * R2 put), not just for the item fetches. A larger backlog drains over successive
 * ticks, because the watermark only advances over ids actually examined.
 */
const MAX_NEW_IDS = 2_500;

/** D1 caps statements per batch; chunk rather than assume a large batch is accepted. */
const BATCH_CHUNK = 100;

/** Cap on changed items examined per run. `updates.json` is typically ~100 ids. */
const MAX_CHANGED = 600;

const RECENT_WINDOW_SECONDS = 48 * 3600;
const RECENT_MAX_ENTRIES = 5_000;

const FETCH_CONCURRENCY = 25;
const PUT_CONCURRENCY = 40;

/**
 * Stories re-fetched per tick to refresh score/descendants/title/url, stalest-first.
 * The re-fetch is the ingest's only way to learn about engagement that happened after
 * posting (see the re-fetch note below). 200/tick at 144 ticks/day cycles a ~600k-row
 * table in ~21 days; each unchanged row costs one Firebase fetch and one cheap UPDATE,
 * and only genuinely changed rows pay for shard rewrites, so the steady-state cost
 * stays well inside the subrequest budget. Kept conservative for the initial backlog
 * drain — every existing row has refreshed_at=0 — but can be raised if the cron
 * budget allows.
 */
const REFRESH_BATCH = 200;

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

export interface IngestResult {
  readonly examined: number;
  readonly stories_upserted: number;
  readonly buckets_touched: number;
  readonly recent_entries: number;
  readonly refreshed_changed: number;
  readonly refreshed_unchanged: number;
  readonly watermark: number;
}

const getJson = async <T>(url: string): Promise<T | null> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;
  return (await response.json()) as T | null;
};

const mapLimit = async <T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += limit) {
    const batch = items.slice(offset, offset + limit);
    results.push(...(await Promise.all(batch.map(worker))));
  }
  return results;
};

const readWatermark = async (env: Env): Promise<number | null> => {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(WATERMARK).first<{ value: string }>();
  if (row === null) return null;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const writeWatermark = async (env: Env, value: number): Promise<void> => {
  await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)')
    .bind(WATERMARK, String(value))
    .run();
};

const isStoryWithUrl = (item: FirebaseItem | null): boolean => {
  if (item === null) return false;
  if (item.type !== 'story') return false;
  if (item.dead === true || item.deleted === true) return false;
  // Firebase returns url: "" for text posts, not an absent field.
  return item.url !== undefined && item.url !== '' && item.title !== undefined && item.time !== undefined;
};

export const ingest = async (env: Env): Promise<IngestResult> => {
  const maxItem = (await getJson<number>(`${FIREBASE}/maxitem.json`)) ?? 0;
  const updates = await getJson<{ items?: number[] }>(`${FIREBASE}/updates.json`);

  const previous = await readWatermark(env);
  // First run on an imported seed: start from the current tip rather than
  // re-walking history, which the seed import already covered.
  const from = previous === null ? maxItem : previous + 1;
  const to = Math.min(maxItem, from + MAX_NEW_IDS - 1);

  const newIds = from <= to ? Array.from({ length: to - from + 1 }, (_, offset) => from + offset) : [];
  const changedIds = (updates?.items ?? []).slice(0, MAX_CHANGED);
  const candidates = [...new Set([...newIds, ...changedIds])];

  const items = await mapLimit(candidates, FETCH_CONCURRENCY, (id) =>
    getJson<FirebaseItem>(`${FIREBASE}/item/${id}.json`),
  );

  /**
   * Rolling re-fetch of the stalest stories' score/descendants/title/url.
   *
   * A story's score and comment count are captured once, when the watermark first
   * reaches it (posting time: score ~1, descendants 0). HN gives no "stories modified
   * since X" signal — `/updates.json` is comment-centric and tiny — so without this
   * pass those counts freeze at posting-time values and the badge lies. Moderator
   * actions (retargeting a URL, editing a title) are likewise invisible to the
   * updates endpoint and benefit from the same rotation. Re-fetch the K stalest rows
   * each tick, stalest-first; `refreshed_at` rotates each row to the back so the
   * whole table cycles over ~3 weeks. Only rows whose score, descendants, url, or
   * title actually changed rejoin `stories` (and so get their shards rewritten);
   * unchanged and confirmed-gone rows just get their `refreshed_at` bumped, which
   * keeps the pass cheap once the index has settled.
   */
  const now = Math.floor(Date.now() / 1000);
  const stalest = await env.DB.prepare(
    'SELECT id, url, title, score, descendants FROM stories ORDER BY refreshed_at ASC, ts ASC LIMIT ?1',
  )
    .bind(REFRESH_BATCH)
    .all<{ id: number; url: string; title: string; score: number; descendants: number }>();
  const staleItems = await mapLimit(stalest.results, FETCH_CONCURRENCY, (row) =>
    getJson<FirebaseItem>(`${FIREBASE}/item/${row.id}.json`),
  );

  const refreshedStories: FirebaseItem[] = [];
  const bumpRefreshed: number[] = [];
  stalest.results.forEach((stored, index) => {
    const item = staleItems[index];
    // Transient failure (non-200 / timeout / parse): leave the row stalest so it
    // retries next tick instead of freezing stale counts for a full cycle.
    if (item === null || item === undefined) return;
    // Dead/deleted/no-url: confirmed gone, rotate out of the queue permanently.
    if (!isStoryWithUrl(item)) {
      bumpRefreshed.push(stored.id);
      return;
    }
    const unchanged =
      (item.score ?? 0) === stored.score &&
      (item.descendants ?? 0) === stored.descendants &&
      item.url === stored.url &&
      (item.title ?? '') === stored.title;
    if (unchanged) {
      bumpRefreshed.push(stored.id);
      return;
    }
    refreshedStories.push(item);
  });

  const stories = (items.filter(isStoryWithUrl) as FirebaseItem[]).concat(refreshedStories);

  const touched = new Set<number>();
  // Grouped per story, never flattened blindly: a story's DELETE and its
  // reinserts must land in the same batch, or a chunk boundary between them
  // leaves the story with no hash rows at all until the next full regen.
  const groups: D1PreparedStatement[][] = [];

  for (const story of stories) {
    const id = story.id;
    const url = story.url;
    if (id === undefined || url === undefined) continue;
    const batch: D1PreparedStatement[] = [];
    groups.push(batch);

    batch.push(
      env.DB.prepare(
        'INSERT OR REPLACE INTO stories (id, url, title, by, score, descendants, ts, refreshed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
      ).bind(id, url, story.title ?? '', story.by ?? '', story.score ?? 0, story.descendants ?? 0, story.time ?? 0, now),
    );

    // A story's URL can change (moderators retarget submissions). Stale variant
    // rows would keep matching a URL the story no longer has, so clear first —
    // in the same batch, so the delete and the reinsert cannot be separated.
    batch.push(env.DB.prepare('DELETE FROM story_hashes WHERE story_id = ?1').bind(id));

    for (const variant of urlVariants(url)) {
      const { h, bucket } = await hashNormalized(variant);
      touched.add(bucket);
      batch.push(
        env.DB.prepare('INSERT OR REPLACE INTO story_hashes (story_id, h, bucket) VALUES (?1,?2,?3)').bind(id, h, bucket),
      );
    }
  }

  // Unchanged or gone re-fetch rows still rotate to the back of the stalest queue, so
  // the stalest-first cursor keeps advancing instead of spinning on them each tick.
  if (bumpRefreshed.length > 0) {
    const bumpGroup: D1PreparedStatement[] = [];
    groups.push(bumpGroup);
    for (const bumpId of bumpRefreshed) {
      bumpGroup.push(env.DB.prepare('UPDATE stories SET refreshed_at = ?1 WHERE id = ?2').bind(now, bumpId));
    }
  }

  // Buckets the story previously occupied must be rewritten too, or a removed
  // variant lingers in a published shard. Collect them before the batch runs.
  if (stories.length > 0) {
    const ids = stories.map((story) => story.id).filter((id): id is number => id !== undefined);
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(',');
    const previousBuckets = await env.DB.prepare(
      `SELECT DISTINCT bucket FROM story_hashes WHERE story_id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{ bucket: number }>();
    for (const row of previousBuckets.results) touched.add(row.bucket);
  }

  // Pack whole groups into batches without ever splitting one.
  let chunk: D1PreparedStatement[] = [];
  for (const group of groups) {
    if (chunk.length > 0 && chunk.length + group.length > BATCH_CHUNK) {
      await env.DB.batch(chunk);
      chunk = [];
    }
    chunk.push(...group);
  }
  if (chunk.length > 0) await env.DB.batch(chunk);

  // Rewrite every touched shard from D1, which is now authoritative.
  const buckets = [...touched];
  for (let offset = 0; offset < buckets.length; offset += PUT_CONCURRENCY) {
    const slice = buckets.slice(offset, offset + PUT_CONCURRENCY);
    await Promise.all(
      slice.map(async (bucket) => {
        const rows = await env.DB.prepare(
          `SELECT h.h AS h, s.id AS id, s.title AS t, s.score AS p, s.descendants AS c, s.ts AS ts
             FROM story_hashes h JOIN stories s ON s.id = h.story_id
            WHERE h.bucket = ?1 ORDER BY h.story_id, h.h`,
        )
          .bind(bucket)
          .all<ShardEntry>();
        await putShard(env, bucket, rows.results);
      }),
    );
  }

  // recent.json covers the 6 h shard edge-cache TTL, not a regen gap.
  const cutoff = Math.floor(Date.now() / 1000) - RECENT_WINDOW_SECONDS;
  const recent = await env.DB.prepare(
    `SELECT h.h AS h, s.id AS id, s.title AS t, s.score AS p, s.descendants AS c, s.ts AS ts
       FROM story_hashes h JOIN stories s ON s.id = h.story_id
      WHERE s.ts >= ?1 ORDER BY s.ts DESC LIMIT ?2`,
  )
    .bind(cutoff, RECENT_MAX_ENTRIES)
    .all<ShardEntry>();
  await putRecent(env, recent.results);

  // Manifest last, always — see publish.ts. Keeps generated_at honest so a client
  // can tell how fresh the index is.
  const total = await env.DB.prepare('SELECT count(*) AS n FROM story_hashes').first<{ n: number }>();
  await putManifest(env, total?.n ?? 0, BUCKET_COUNT);

  // Advance the watermark only over ids actually examined.
  if (newIds.length > 0 || previous === null) await writeWatermark(env, to > 0 ? to : maxItem);

  return {
    examined: candidates.length,
    stories_upserted: stories.length,
    buckets_touched: touched.size,
    recent_entries: recent.results.length,
    refreshed_changed: refreshedStories.length,
    refreshed_unchanged: bumpRefreshed.length,
    watermark: to > 0 ? to : maxItem,
  };
};
