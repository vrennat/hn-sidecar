/**
 * Verifies the shards the INGEST CRON wrote — which `verify.ts` structurally cannot.
 *
 * `verify.ts` samples the seed file, so every shard it checks was written by the
 * regen batch. Ingest has its own publish path (delete-then-reinsert, previous-bucket
 * collection, per-bucket rewrite query) and none of it is exercised by that check.
 * A rising `entry_count` only proves D1 moved, not that R2 did.
 *
 * So this starts from `recent.json` — an artifact only ingest writes — takes the
 * newest stories in it, re-derives each hash from Firebase's raw URL, and asserts
 * the entry is present in BOTH `recent.json` and the story's shard. The second
 * assertion is the load-bearing one.
 *
 * It also exercises recent.json's actual job: a story posted minutes ago
 * must be findable even while a client holds a shard cached for up to 6 h.
 *
 *   bun run src/verify-ingest.ts --origin https://pub-xxx.r2.dev --count 25
 */

import {
  RECENT_KEY,
  SHARD_KEY,
  hashUrl,
  type RecentIndex,
  type Shard,
} from '@hn-sidecar/shared';
import { arg, intArg } from '@hn-sidecar/toolkit';

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return (await response.json()) as T;
};

const main = async (): Promise<void> => {
  const origin = arg('origin', '').replace(/\/$/, '');
  const count = intArg('count', 25);
  if (origin.length === 0) throw new Error('--origin <url> is required');

  const recent = await getJson<RecentIndex>(`${origin}/${RECENT_KEY}`);
  const age = Math.floor(Date.now() / 1000) - recent.generated_at;
  console.info(`recent.json: ${recent.entries.length} entries, generated ${age}s ago`);

  // Newest first — these are the ones only ingest can have published.
  const newest = [...recent.entries].sort((left, right) => right.id - left.id).slice(0, count);
  if (newest.length === 0) throw new Error('recent.json is empty; ingest has not run');

  console.info(`checking the ${newest.length} newest entries against their shards\n`);

  let inShard = 0;
  let hashMismatch = 0;
  let missingFromShard = 0;
  let gone = 0;
  const failures: string[] = [];

  for (const entry of newest) {
    const item = await getJson<{ url?: string; title?: string } | null>(`${FIREBASE}/item/${entry.id}.json`);
    const url = item?.url;
    if (url === undefined || url === '') {
      gone += 1;
      continue;
    }

    // Re-derive the hash from the raw URL rather than trusting the published one.
    const hash = await hashUrl(url);
    if (hash === null || hash.h !== entry.h) {
      hashMismatch += 1;
      failures.push(`  id ${entry.id}: published h ${entry.h} != rederived ${hash?.h ?? 'null'}  (${url})`);
      continue;
    }

    const shard = await getJson<Shard>(`${origin}/${SHARD_KEY(hash.shard)}`);
    const hit = shard.e.find((candidate) => candidate.h === hash.h && candidate.id === entry.id);
    if (hit === undefined) {
      missingFromShard += 1;
      failures.push(`  id ${entry.id}: in recent.json but NOT in shard ${hash.shard}  (${url})`);
      continue;
    }
    inShard += 1;
  }

  console.info(`  present in both recent.json and shard  ${inShard}`);
  console.info(`  in recent.json but missing from shard  ${missingFromShard}`);
  console.info(`  published hash != rederived hash        ${hashMismatch}`);
  console.info(`  story no longer has a URL               ${gone}`);
  if (failures.length > 0) console.info(`\nfailures:\n${failures.slice(0, 15).join('\n')}`);

  if (missingFromShard > 0 || hashMismatch > 0) {
    throw new Error('ingest published recent.json entries that its shards do not agree with');
  }
  console.info('\ningest publish path verified against R2, not just D1');
};

await main();
