/**
 * Ingest cron, every 10 minutes.
 *
 * Polls Firebase's latest/front-page feeds, changed items and maxitem watermark, upserts into D1,
 * rewrites only the touched shards, then rewrites `recent.json`. Everything is
 * idempotent: a failed run is simply retried by the next tick, and a partially
 * applied run leaves D1 and the shards consistent because shards are always
 * derived from D1 rather than patched.
 */

import { BUCKET_COUNT, hashNormalized, urlVariants, type ShardEntry } from '@hn-sidecar/shared';
import type { Env } from './env.ts';
import { readHashCount, recountHashes, withHashCount } from './hash-count.ts';
import { deferItems, DUE_ITEMS_SQL, RETRY_BATCH } from './item-retries.ts';
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

// Keep today's stories discoverable even when the sequential watermark is months
// behind. These public feeds do not move that cursor. The front page also refreshes
// engagement on active discussions without waiting for the historical rotation.
const LIVE_FEED_LIMIT = 100;

const RECENT_WINDOW_SECONDS = 48 * 3600;
const RECENT_MAX_ENTRIES = 5_000;

const FETCH_CONCURRENCY = 25;
const FETCH_BUDGET_MS = 45_000;
const ITEM_TIMEOUT_MS = 5_000;
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
  readonly items_deferred: number;
  readonly shards_written: number;
  readonly stories_upserted: number;
  readonly buckets_touched: number;
  readonly recent_entries: number;
  readonly refreshed_changed: number;
  readonly refreshed_unchanged: number;
  readonly watermark: number;
}

const getJson = async <T>(url: string, timeoutMs = 15_000): Promise<T | null> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  // A transport failure must remain distinguishable from a confirmed JSON null.
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return (await response.json()) as T | null;
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

async function fetchItems(ids: readonly number[], from: number, to: number) {
  const fetched = new Map<number, FirebaseItem | null>();
  const failed = new Set<number>();
  const deadline = Date.now() + FETCH_BUDGET_MS;
  let failedNew = 0;
  let holdCursor = false;
  for (let offset = 0; offset < ids.length && Date.now() + ITEM_TIMEOUT_MS <= deadline; offset += FETCH_CONCURRENCY) {
    const batch = ids.slice(offset, offset + FETCH_CONCURRENCY);
    const before = failed.size;
    const beforeNew = failedNew;
    await Promise.all(batch.map(async id => {
      try {
        fetched.set(id, await getJson<FirebaseItem>(`${FIREBASE}/item/${id}.json`, ITEM_TIMEOUT_MS));
      } catch {
        failed.add(id);
        if (id >= from && id <= to) failedNew++;
      }
    }));
    // Check each wave, so an outage late in a catch-up cannot hide behind earlier successes.
    if ((batch.length >= 20 && failed.size - before >= batch.length / 4) || failedNew > RETRY_BATCH / 2) {
      holdCursor = failedNew !== beforeNew || failedNew > RETRY_BATCH / 2;
      console.warn('Firebase item circuit opened', { waveFailures: failed.size - before, failedNew });
      break;
    }
  }
  if (failedNew > 0 && fetched.size === 0) holdCursor = true;
  return { fetched, failed, holdCursor };
}

export const ingest = async (env: Env): Promise<IngestResult> => {
  // Both the cron and /ingest can publish. An older R2 put completing after a
  // newer publisher retired its dirty marker would otherwise undo the repair.
  // Expiry lets a subsequent cron recover from an isolate that never ran finally.
  const leaseUntil = Date.now() + 20 * 60_000;
  const lease = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('ingest_lease_until', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value
     WHERE CAST(meta.value AS INTEGER) <= ?2 RETURNING value`,
  ).bind(String(leaseUntil), Date.now()).first();
  if (!lease) throw new Error('Ingest already running');
  const checkLease = () => {
    // Leave time for the last in-flight batch to settle before another writer starts.
    if (Date.now() >= leaseUntil - 2 * 60_000) throw new Error('Ingest lease nearing expiry');
  };
  try {
    return await ingestWithLease(env, checkLease);
  } finally {
    await env.DB.prepare("DELETE FROM meta WHERE key='ingest_lease_until' AND value=?")
      .bind(String(leaseUntil)).run();
  }
};

const ingestWithLease = async (env: Env, checkLease: () => void): Promise<IngestResult> => {
  const maxItem = await getJson<number>(`${FIREBASE}/maxitem.json`);
  if (maxItem === null || !Number.isSafeInteger(maxItem) || maxItem < 1) {
    throw new Error('Firebase maxitem is not a positive integer');
  }
  const updates = await getJson<{ items?: number[] }>(`${FIREBASE}/updates.json`);
  const liveFeeds = await Promise.all(
    ['newstories', 'topstories'].map(async (feed) => {
      const ids = await getJson<number[]>(`${FIREBASE}/${feed}.json`);
      if (!Array.isArray(ids)) throw new Error(`Firebase ${feed} is not an ID list`);
      return ids.slice(0, LIVE_FEED_LIMIT).filter((id) => Number.isSafeInteger(id) && id > 0);
    }),
  );

  const previous = await readWatermark(env);
  // First run on an imported seed: start from the current tip rather than
  // re-walking history, which the seed import already covered.
  const from = previous === null ? maxItem : previous + 1;
  const to = Math.min(maxItem, from + MAX_NEW_IDS - 1);

  const newIds = from <= to ? Array.from({ length: to - from + 1 }, (_, offset) => from + offset) : [];
  const changedIds = (updates?.items ?? []).slice(0, MAX_CHANGED);
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(DUE_ITEMS_SQL).bind(now, RETRY_BATCH).all<{ id: number }>();
  const feedIds = new Set([...liveFeeds.flat(), ...changedIds]);
  const dueIds = new Set(due.results.map(row => row.id));
  // Give current stories and the cursor a first wave, then service due work
  // before a long historical catch-up can consume the wall-clock budget.
  const candidates = new Set([...feedIds, ...newIds.slice(0, FETCH_CONCURRENCY), ...dueIds, ...newIds]);

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
  const stalest = await env.DB.prepare(
    'SELECT id, url, title, score, descendants FROM stories ORDER BY refreshed_at ASC, ts ASC LIMIT ?1',
  )
    .bind(REFRESH_BATCH)
    .all<{ id: number; url: string; title: string; score: number; descendants: number }>();
  const storedById = new Map(stalest.results.map(row => [row.id, row]));
  const ids = [...new Set([...candidates, ...storedById.keys()])];
  const { fetched, failed, holdCursor } = await fetchItems(ids, from, to);
  let watermark = previous ?? from - 1;
  if (!holdCursor) {
    for (const id of newIds) {
      if (!fetched.has(id) && !failed.has(id)) break;
      watermark = id;
    }
  }

  // A held cursor already preserves its historical holes. Keep independent feed
  // misses and drain previously queued IDs, even on a retry-only tick.
  checkLease();
  const deferred = [...failed].filter(id => candidates.has(id) && !storedById.has(id)
    && (id <= watermark || id > to || feedIds.has(id) || dueIds.has(id)));
  const skippedFeeds = [...feedIds].filter(id => !failed.has(id) && !fetched.has(id));
  await deferItems(env, now, skippedFeeds, deferred);

  const stories: FirebaseItem[] = [];
  const bumpRefreshed: number[] = [];
  let refreshedChanged = 0;
  let refreshedUnchanged = 0;
  for (const id of failed) {
    if (storedById.has(id)) bumpRefreshed.push(id);
  }
  for (const [id, item] of fetched) {
    const stored = storedById.get(id);
    if (!item || !isStoryWithUrl(item)) {
      if (stored) bumpRefreshed.push(id);
      continue;
    }
    if (stored) {
      if ((item.score ?? 0) === stored.score && (item.descendants ?? 0) === stored.descendants
          && item.url === stored.url && item.title === stored.title) {
        bumpRefreshed.push(id);
        refreshedUnchanged++;
        continue;
      }
      refreshedChanged++;
    }
    stories.push(item);
  }

  // Grouped per story, never flattened blindly: a story's DELETE and its
  // reinserts must land in the same batch, or a chunk boundary between them
  // leaves the story with no hash rows at all until the next full regen.
  const groups: { storyId?: number; statements: D1PreparedStatement[] }[] = [];

  for (const story of stories) {
    const id = story.id;
    const url = story.url;
    if (id === undefined || url === undefined) continue;
    const batch: D1PreparedStatement[] = [];
    groups.push({ storyId: id, statements: batch });

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
      batch.push(
        env.DB.prepare('INSERT OR REPLACE INTO story_hashes (story_id, h, bucket) VALUES (?1,?2,?3)').bind(id, h, bucket),
      );
    }
  }

  // Unchanged or gone re-fetch rows still rotate to the back of the stalest queue, so
  // the stalest-first cursor keeps advancing instead of spinning on them each tick.
  for (const id of bumpRefreshed) {
    groups.push({ statements: [env.DB.prepare('UPDATE stories SET refreshed_at = ?1 WHERE id = ?2').bind(now, id)] });
  }

  // The batches below adjust the manifest's entry counter rather than recounting
  // the table; seed it once if it has never been written.
  let entryCount = await readHashCount(env);
  if (entryCount === null) entryCount = await recountHashes(env);

  // Pack whole groups into batches without ever splitting one. Reserve four statements for
  // counter adjustments and the old/new dirty bucket snapshots.
  const runChunk = async (chunk: readonly { storyId?: number; statements: D1PreparedStatement[] }[]) => {
    checkLease();
    const storyIds = chunk.flatMap((group) => (group.storyId === undefined ? [] : [group.storyId]));
    const statements = chunk.flatMap(group => group.statements);
    if (storyIds.length) {
      const placeholders = storyIds.map(() => '?').join(',');
      const markBuckets = () => env.DB.prepare(
        `INSERT OR REPLACE INTO dirty_shards (updated_at, bucket)
         SELECT DISTINCT ?, bucket FROM story_hashes WHERE story_id IN (${placeholders})`,
      ).bind(Date.now(), ...storyIds);
      statements.unshift(markBuckets());
      statements.push(markBuckets());
    }
    await env.DB.batch(withHashCount(env, storyIds, statements));
  };
  let chunk: typeof groups = [];
  let chunkSize = 0;
  for (const group of groups) {
    if (chunkSize > 0 && chunkSize + group.statements.length > BATCH_CHUNK - 4) {
      await runChunk(chunk);
      chunk = [];
      chunkSize = 0;
    }
    chunk.push(group);
    chunkSize += group.statements.length;
  }
  if (chunkSize > 0) await runChunk(chunk);

  // Existing stories already have a durable refresh path, even if a legacy
  // retry row happened to overlap a failed fetch.
  const recovered = [...fetched.keys(), ...[...failed].filter(id => storedById.has(id))];
  for (let offset = 0; offset < recovered.length; offset += BATCH_CHUNK) {
    const slice = recovered.slice(offset, offset + BATCH_CHUNK);
    await env.DB.prepare(`DELETE FROM item_retries WHERE id IN (${slice.map(() => '?').join(',')})`)
      .bind(...slice).run();
  }

  // Rewrite every touched shard from D1, which is now authoritative.
  let shardsWritten = 0;
  const { results: buckets } = await env.DB.prepare('SELECT bucket, updated_at FROM dirty_shards')
    .all<{ bucket: string; updated_at: number }>();
  for (let offset = 0; offset < buckets.length; offset += PUT_CONCURRENCY) {
    checkLease();
    const slice = buckets.slice(offset, offset + PUT_CONCURRENCY);
    const writes = await Promise.allSettled(
      slice.map(async ({ bucket }) => {
        const rows = await env.DB.prepare(
          `SELECT h.h AS h, s.id AS id, s.title AS t, s.score AS p, s.descendants AS c, s.ts AS ts
             FROM story_hashes h JOIN stories s ON s.id = h.story_id
            WHERE h.bucket = ?1 ORDER BY h.story_id, h.h`,
        )
          .bind(bucket)
          .all<ShardEntry>();
        if (await putShard(env, Number(bucket), rows.results, true)) shardsWritten++;
      }),
    );
    for (const write of writes) if (write.status === 'rejected') throw write.reason;
    await env.DB.batch(slice.map(row => env.DB.prepare(
      'DELETE FROM dirty_shards WHERE bucket = ? AND updated_at = ?',
    ).bind(row.bucket, row.updated_at)));
  }

  if (failed.size > 0 && fetched.size === 0) {
    if (previous === null) await writeWatermark(env, watermark);
    throw new Error('All Firebase item requests failed');
  }

  // recent.json covers the 6 h shard edge-cache TTL, not a regen gap.
  checkLease();
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
  await putManifest(env, (await readHashCount(env)) ?? entryCount, BUCKET_COUNT);

  if (previous !== watermark) await writeWatermark(env, watermark);

  return {
    examined: [...candidates].filter(id => fetched.has(id) || failed.has(id)).length,
    items_deferred: deferred.length + skippedFeeds.length,
    shards_written: shardsWritten,
    stories_upserted: stories.length,
    buckets_touched: buckets.length,
    recent_entries: recent.results.length,
    refreshed_changed: refreshedChanged,
    refreshed_unchanged: refreshedUnchanged,
    watermark,
  };
};
