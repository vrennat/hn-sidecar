import { describe, expect, it } from 'bun:test';
import type { ShardEntry } from '@hn-sidecar/shared';
import { toSubmissions, totalComments } from './submissions.ts';

const HASH = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

const entry = (overrides: Partial<ShardEntry> & { id: number }): ShardEntry => ({
  h: HASH,
  t: `story ${overrides.id}`,
  p: 10,
  c: 5,
  ts: 1_700_000_000,
  ...overrides,
});

describe('toSubmissions', () => {
  describe('happy path', () => {
    it('keeps distinct story ids sharing one hash — this is "discussed 4 times"', () => {
      const result = toSubmissions([entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })], HASH);
      expect(result).toHaveLength(3);
    });

    it('orders by comment count, highest first', () => {
      const result = toSubmissions([entry({ id: 1, c: 5 }), entry({ id: 2, c: 90 }), entry({ id: 3, c: 40 })], HASH);
      expect(result.map((submission) => submission.id)).toEqual([2, 3, 1]);
    });
  });

  describe('hash filtering', () => {
    it('ignores entries for other URLs in the same shard', () => {
      // The whole point of the 14-bit prefix: a shard holds hundreds of unrelated URLs.
      expect(toSubmissions([entry({ id: 1 }), entry({ id: 2, h: OTHER })], HASH).map((s) => s.id)).toEqual([1]);
    });

    it('returns nothing when no entry matches', () => {
      expect(toSubmissions([entry({ id: 1, h: OTHER })], HASH)).toEqual([]);
    });
  });

  describe('the dedupe the badge depends on', () => {
    it('counts a story once when recent.json and the shard both carry it', () => {
      // A story posted in the last 48 h appears in both files. Summing both would
      // inflate the badge silently, which is the failure this guards.
      const result = toSubmissions([entry({ id: 1, c: 40 }), entry({ id: 1, c: 42 })], HASH);
      expect(result).toHaveLength(1);
      expect(totalComments(result)).toBe(42);
    });

    it('keeps the higher count regardless of order', () => {
      expect(toSubmissions([entry({ id: 1, c: 42 }), entry({ id: 1, c: 40 })], HASH)[0]?.comments).toBe(42);
    });
  });

  describe('edge cases', () => {
    it('handles an empty shard', () => {
      expect(toSubmissions([], HASH)).toEqual([]);
    });

    it('totals zero for no submissions', () => {
      expect(totalComments([])).toBe(0);
    });
  });
});
