/**
 * Writing artifacts to R2. Shared by the regen batch and the ingest cron.
 */

import {
  ARTIFACT_VERSION,
  MANIFEST_KEY,
  NORM_VERSION,
  RECENT_KEY,
  SHARD_KEY,
  shardName,
  type Manifest,
  type RecentIndex,
  type Shard,
  type ShardEntry,
} from '@hn-sidecar/shared';
import type { Env } from './env.ts';

/** Edge TTLs. Cache-Control is what a Cache Everything rule respects. */
const SHARD_CACHE_CONTROL = 'public, max-age=21600';
const VOLATILE_CACHE_CONTROL = 'public, max-age=300';

const putJson = async (env: Env, key: string, body: unknown, cacheControl: string): Promise<void> => {
  await env.INDEX.put(key, JSON.stringify(body), {
    httpMetadata: { contentType: 'application/json', cacheControl },
  });
};

export const putShard = async (env: Env, bucket: number, entries: readonly ShardEntry[], skipUnchanged = false): Promise<boolean> => {
  const b = shardName(bucket);
  const shard: Shard = { av: ARTIFACT_VERSION, nv: NORM_VERSION, b, e: entries };
  const key = SHARD_KEY(b);
  const body = JSON.stringify(shard);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  if (skipUnchanged) {
    const existing = await env.INDEX.head(key);
    const checksum = existing?.checksums.sha256;
    const bytes = new Uint8Array(digest);
    if (checksum && new Uint8Array(checksum).every((byte, i) => byte === bytes[i])) return false;
  }
  await env.INDEX.put(key, body, {
    sha256: digest,
    httpMetadata: { contentType: 'application/json', cacheControl: SHARD_CACHE_CONTROL },
  });
  return true;
};

export const putRecent = async (env: Env, entries: readonly ShardEntry[]): Promise<void> => {
  const recent: RecentIndex = {
    av: ARTIFACT_VERSION,
    nv: NORM_VERSION,
    generated_at: Math.floor(Date.now() / 1000),
    entries,
  };
  await putJson(env, RECENT_KEY, recent, VOLATILE_CACHE_CONTROL);
};

/**
 * Written LAST by any publish, always.
 *
 * A client that reads a fresh manifest and then a stale shard is the one ordering
 * that yields a *wrong* answer rather than merely a stale one. Manifest-last means
 * the worst case is a client believing the index is older than it is, which is
 * harmless.
 */
export const putManifest = async (env: Env, entryCount: number, shardCount: number): Promise<void> => {
  const manifest: Manifest = {
    av: ARTIFACT_VERSION,
    nv: NORM_VERSION,
    generated_at: Math.floor(Date.now() / 1000),
    entry_count: entryCount,
    shard_count: shardCount,
  };
  await putJson(env, MANIFEST_KEY, manifest, VOLATILE_CACHE_CONTROL);
};
