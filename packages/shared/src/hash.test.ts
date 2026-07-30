import { describe, expect, it } from 'bun:test';
import { BUCKET_COUNT, bucketOf, hashNormalized, hashUrl, shardName } from './hash.ts';
import { FROZEN_HASHES } from './frozen.ts';
import { GOLDEN_VECTORS } from './vectors.ts';

describe('bucketOf', () => {
  it('takes the high 14 bits, most-significant first', () => {
    // 0b11011110 0b10110111 -> 0b11011110101101 = 0x37ad
    expect(bucketOf(Uint8Array.from([0xde, 0xb7, 0x00]))).toBe(0x37ad);
  });

  it('ignores the low 2 bits of the second byte', () => {
    expect(bucketOf(Uint8Array.from([0xde, 0xb4]))).toBe(bucketOf(Uint8Array.from([0xde, 0xb7])));
  });

  it('spans the full 14-bit range', () => {
    expect(bucketOf(Uint8Array.from([0x00, 0x00]))).toBe(0);
    expect(bucketOf(Uint8Array.from([0xff, 0xff]))).toBe(BUCKET_COUNT - 1);
  });

  it('throws rather than silently bucketing a short digest', () => {
    expect(() => bucketOf(Uint8Array.from([0x01]))).toThrow();
  });
});

describe('shardName', () => {
  it('zero-pads to four hex chars', () => {
    expect(shardName(0)).toBe('0000');
  });

  it('tops out at 3fff, since 14 bits cannot reach ffff', () => {
    expect(shardName(BUCKET_COUNT - 1)).toBe('3fff');
  });
});

describe('hashNormalized', () => {
  it('produces a 64-char full digest and a 32-char truncation', async () => {
    const hash = await hashNormalized('example.com/a');
    expect(hash.full).toHaveLength(64);
    expect(hash.h).toHaveLength(32);
  });

  it('truncates rather than re-hashing', async () => {
    const hash = await hashNormalized('example.com/a');
    expect(hash.full.startsWith(hash.h)).toBe(true);
  });

  it('agrees with the shard derived from its own digest', async () => {
    const hash = await hashNormalized('example.com/a');
    expect(hash.shard).toBe(shardName(hash.bucket));
  });

  describe('frozen digests', () => {
    for (const [normalized, frozen] of Object.entries(FROZEN_HASHES)) {
      it(`${normalized} still hashes to ${frozen.shard}`, async () => {
        const hash = await hashNormalized(normalized);
        expect({ full: hash.full, h: hash.h, shard: hash.shard }).toEqual(frozen);
      });
    }
  });
});

describe('hashUrl', () => {
  it('returns null for input that cannot be normalized', async () => {
    expect(await hashUrl('not a url')).toBeNull();
  });

  describe('golden vectors reach their frozen shard', () => {
    for (const vector of GOLDEN_VECTORS) {
      if (vector.normalized === null) continue;
      const frozen = FROZEN_HASHES[vector.normalized];
      it(`${vector.input} -> ${frozen?.shard}`, async () => {
        const hash = await hashUrl(vector.input);
        expect(hash?.shard).toBe(frozen?.shard);
        expect(hash?.h).toBe(frozen?.h);
      });
    }
  });
});
