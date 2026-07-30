/**
 * The published artifact formats. Both the write path (regen batch, ingest cron)
 * and the read path (extension) depend on these types, so they live in shared.
 */

/** Bump when the shape of a shard or manifest changes incompatibly. */
export const ARTIFACT_VERSION = 1;

/** One submission of one URL. Multiple entries per story id are expected. */
export interface ShardEntry {
  /** 128-bit truncated digest, 32 hex chars. */
  readonly h: string;
  /** HN story id. */
  readonly id: number;
  /** Title. Stays in the shard by design — see the guardrail note below. */
  readonly t: string;
  /** Points. */
  readonly p: number;
  /** Comment count. */
  readonly c: number;
  /** Unix seconds. */
  readonly ts: number;
}

/**
 * A shard file, `/b/{0000..3fff}.json`.
 *
 * Titles are inlined **on purpose**. A client that hash-matched and then fetched
 * titles by story id would disclose the exact story to whoever served that
 * request, which is the whole thing the 14-bit prefix exists to prevent. This is
 * why the shard is self-contained; never "optimize" the titles out.
 *
 * `nv` and `av` are repeated here rather than read only from the manifest
 * because the two artifacts have different edge TTLs (6 h vs 5 min), so a client
 * can legitimately hold a new manifest and a stale shard. Self-describing shards
 * make that detectable instead of silently wrong.
 */
export interface Shard {
  readonly av: number;
  readonly nv: number;
  /** Shard id, 4 lowercase hex chars. Guards against a misrouted file. */
  readonly b: string;
  readonly e: readonly ShardEntry[];
}

/**
 * `/recent.json` — stories from the last 48 h, carrying 128-bit truncated digests.
 *
 * Its job is covering the shard edge-cache TTL, not a regen gap: ingest rewrites
 * touched shards within ~10 min, but a client may hold a shard cached for up to
 * 6 h, so this is what makes a URL posted 20 minutes ago badge correctly.
 */
export interface RecentIndex {
  readonly av: number;
  readonly nv: number;
  readonly generated_at: number;
  readonly entries: readonly ShardEntry[];
}

/** `/manifest.json` — written last by any publish, so it never promises a shard that is not there. */
export interface Manifest {
  readonly av: number;
  readonly nv: number;
  readonly generated_at: number;
  /** Total entries across all shards, for a cheap sanity check after publish. */
  readonly entry_count: number;
  readonly shard_count: number;
}

export const SHARD_KEY = (shard: string): string => `b/${shard}.json`;
export const RECENT_KEY = 'recent.json';
export const MANIFEST_KEY = 'manifest.json';
