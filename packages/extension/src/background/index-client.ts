/**
 * Reads the static index. This is the entire read path: three kinds of
 * plain JSON file on a CDN, no server of ours involved in any user request.
 *
 * TTLs mirror the artifacts' own `Cache-Control` rather than inventing a second
 * policy, except for shards: their 6 h edge TTL is deliberately long, and the client
 * holds them for 1 h because `recent.json` is what covers the gap.
 */

import {
  ARTIFACT_VERSION,
  MANIFEST_KEY,
  NORM_VERSION,
  RECENT_KEY,
  SHARD_KEY,
  type Manifest,
  type RecentIndex,
  type Shard,
} from '@hn-sidecar/shared';
import { INDEX_ORIGIN } from '../config.ts';
import { cacheGet, cacheSet } from './session-cache.ts';

const MANIFEST_TTL_MS = 5 * 60_000;
const RECENT_TTL_MS = 5 * 60_000;
const SHARD_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Raised when an artifact declares a version this build does not implement.
 *
 * Distinct from a transport failure on purpose: "update the extension" and "the lookup
 * failed" are different things to tell the user, and the shard's own `nv` is often the
 * only place a skew is visible — the manifest fetch may itself have failed.
 */
export class IndexVersionError extends Error {}

const fetchJson = async <T>(key: string, refresh: boolean): Promise<T> => {
  const response = await fetch(`${INDEX_ORIGIN}/${key}`, {
    // No cookies to send and none wanted: the index is public and anonymous.
    credentials: 'omit',
    cache: refresh ? 'reload' : 'default',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET /${key} -> ${response.status}`);
  return (await response.json()) as T;
};

/**
 * Concurrent lookups for the same key join one fetch instead of fetching twice.
 *
 * This happens in ordinary use: a navigation fires `tabs.onUpdated` and a panel
 * `get-finding` together, and two tabs can land on same-shard URLs in the same
 * second. The map lives in worker memory only — MV3 termination clears it — which is
 * exactly the window in which the concurrency exists.
 */
const inflight = new Map<string, { run: Promise<unknown>; refresh: boolean }>();

const cachedJson = async <T>(key: string, ttlMs: number, refresh = false): Promise<T> => {
  if (!refresh) {
    const hit = await cacheGet<T>(key);
    if (hit !== null) return hit;
  }
  const pending = inflight.get(key);
  if (pending && (!refresh || pending.refresh)) return (await pending.run) as T;
  const entry = { refresh, run: Promise.resolve(undefined) as Promise<unknown> };
  entry.run = fetchJson<T>(key, refresh)
    .then(async (value) => {
      // A refresh supersedes an ordinary fetch; its older result cannot repopulate cache.
      if (inflight.get(key) === entry) await cacheSet(key, value, ttlMs);
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
    });
  inflight.set(key, entry);
  return (await entry.run) as T;
};

export const getManifest = (refresh = false): Promise<Manifest> =>
  cachedJson<Manifest>(MANIFEST_KEY, MANIFEST_TTL_MS, refresh);
export const getRecent = (refresh = false): Promise<RecentIndex> =>
  cachedJson<RecentIndex>(RECENT_KEY, RECENT_TTL_MS, refresh);

/**
 * Fetches one shard and validates what the shard says about itself.
 *
 * The `nv`/`av`/`b` fields exist precisely so this check is possible: shards have a
 * 6 h edge TTL and the manifest 5 min, so a client can legitimately hold a fresh
 * manifest alongside a stale shard. Trusting the manifest's `nv` for a shard's
 * contents would make that case silently wrong instead of detectable.
 */
export const getShard = async (shard: string, refresh = false): Promise<Shard> => {
  const value = await cachedJson<Shard>(SHARD_KEY(shard), SHARD_TTL_MS, refresh);
  // A misroute is a transport problem, not a version problem: the file we got is not
  // the file we asked for, and retrying may well fix it.
  if (value.b !== shard) throw new Error(`shard ${shard} self-reports as ${value.b}`);
  if (value.av !== ARTIFACT_VERSION) {
    throw new IndexVersionError(`index is artifact v${value.av}, this build implements v${ARTIFACT_VERSION}`);
  }
  if (value.nv !== NORM_VERSION) {
    throw new IndexVersionError(`index is norm v${value.nv}, this build implements v${NORM_VERSION}`);
  }
  return value;
};
