/**
 * Hash construction. WebCrypto only — this module runs in a Cloudflare Worker,
 * an MV3 service worker, and a bun script, and `node:crypto` is not available in
 * all three. Do not introduce node builtins here.
 */

import { NORM_VERSION, normalizeUrl } from './normalize.ts';

/** Prefix bits used to select a shard file. 14 bits => 16,384 shards, k ~= 272. */
export const BUCKET_BITS = 14;
export const BUCKET_COUNT = 1 << BUCKET_BITS;

/** Bytes of the digest stored as the `h` field of a shard entry (128-bit truncation). */
export const TRUNCATED_HASH_BYTES = 16;

export interface UrlHash {
  /** Canonical normalized form the digest was taken over. */
  readonly normalized: string;
  /** Full SHA-256 as lowercase hex, 64 chars. Never published. */
  readonly full: string;
  /** First 16 bytes of the digest as lowercase hex, 32 chars. The shard entry's `h`. */
  readonly h: string;
  /** High 14 bits of the digest, 0..16383. */
  readonly bucket: number;
  /** `bucket` as 4 lowercase hex chars: "0000".."3fff". The shard filename. */
  readonly shard: string;
}

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string => {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
};

/**
 * High 14 bits of the digest, most-significant first: `(b0 << 6) | (b1 >> 2)`.
 *
 * This is the one definition. Note that 4 hex chars can express 16 bits, so the
 * shard filename is a zero-padded rendering of a 14-bit value and only spans
 * 0000..3fff — it is NOT the first four hex characters of the digest.
 */
export const bucketOf = (digest: Uint8Array): number => {
  const b0 = digest[0];
  const b1 = digest[1];
  if (b0 === undefined || b1 === undefined) throw new Error('digest too short');
  return (b0 << 6) | (b1 >> 2);
};

export const shardName = (bucket: number): string => bucket.toString(16).padStart(4, '0');

/** Hash input is `${NORM_VERSION}|${normalized}`. */
export const hashNormalized = async (normalized: string): Promise<UrlHash> => {
  const input = `${NORM_VERSION}|${normalized}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
  const bucket = bucketOf(digest);
  return {
    normalized,
    full: toHex(digest),
    h: toHex(digest.subarray(0, TRUNCATED_HASH_BYTES)),
    bucket,
    shard: shardName(bucket),
  };
};

/** Normalize then hash. Returns `null` when the input is not an http(s) URL. */
export const hashUrl = async (input: string): Promise<UrlHash | null> => {
  const normalized = normalizeUrl(input);
  if (normalized === null) return null;
  return hashNormalized(normalized);
};
