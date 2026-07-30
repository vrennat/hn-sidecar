import { describe, expect, it } from 'bun:test';
import { normalizeUrl, urlVariants } from './normalize.ts';
import { GOLDEN_VECTORS } from './vectors.ts';

describe('normalizeUrl', () => {
  describe('golden vectors', () => {
    for (const vector of GOLDEN_VECTORS) {
      it(`${vector.why}: ${vector.input}`, () => {
        expect(normalizeUrl(vector.input)).toBe(vector.normalized);
      });
    }
  });

  describe('idempotence', () => {
    for (const vector of GOLDEN_VECTORS) {
      if (vector.normalized === null) continue;
      it(`re-normalizing ${vector.normalized} is a no-op`, () => {
        expect(normalizeUrl(`https://${vector.normalized}`)).toBe(vector.normalized);
      });
    }
  });

  describe('collisions that must happen', () => {
    const equivalent: readonly (readonly string[])[] = [
      ['http://www.example.com/a/', 'https://example.com/a', 'https://EXAMPLE.COM/a?utm_source=x'],
      ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9'],
      ['https://m.example.com/p?fbclid=1', 'https://example.com/p'],
    ];
    for (const [first, ...rest] of equivalent) {
      for (const other of rest) {
        it(`${first} === ${other}`, () => {
          expect(normalizeUrl(other!)).toBe(normalizeUrl(first!));
        });
      }
    }
  });

  describe('collisions that must not happen', () => {
    const distinct: readonly (readonly [string, string])[] = [
      ['https://example.com/a', 'https://example.com/b'],
      ['https://example.com/story?page=2', 'https://example.com/story?page=3'],
      ['https://example.com/A', 'https://example.com/a'],
      ['https://example.com/a', 'https://other.com/a'],
      ['https://youtube.com/watch?v=aaaaaaaaaaa', 'https://youtube.com/watch?v=bbbbbbbbbbb'],
    ];
    for (const [left, right] of distinct) {
      it(`${left} !== ${right}`, () => {
        expect(normalizeUrl(left)).not.toBe(normalizeUrl(right));
      });
    }
  });

  describe('error cases', () => {
    it('rejects the empty string', () => {
      expect(normalizeUrl('')).toBeNull();
    });

    it('rejects a scheme-relative URL, which has no origin of its own', () => {
      expect(normalizeUrl('//example.com/a')).toBeNull();
    });

    it('rejects javascript: URLs', () => {
      expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    });

    it('rejects HN text posts, which have no URL', () => {
      expect(normalizeUrl('item?id=123')).toBeNull();
    });
  });
});

describe('urlVariants', () => {
  it('returns the canonical form first', () => {
    expect(urlVariants('https://example.com/a?id=1')[0]).toBe('example.com/a?id=1');
  });

  it('returns nothing for a URL that cannot be normalized', () => {
    expect(urlVariants('not a url')).toEqual([]);
  });

  describe('no variant may collapse documents that the query distinguishes', () => {
    // Regression guard. A query-stripped variant made every YouTube video publish
    // the hash of bare `youtube.com/watch`: 20,344 stories on one hash, a 2.8 MB
    // shard, and a 20,000-way false positive. Any future variant must not
    // reintroduce a form shared by two genuinely different documents.
    const distinctByQueryOnly: readonly (readonly [string, string])[] = [
      ['https://www.youtube.com/watch?v=aaaaaaaaaaa', 'https://www.youtube.com/watch?v=bbbbbbbbbbb'],
      ['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'],
      ['https://example.com/story?id=1', 'https://example.com/story?id=2'],
      ['https://example.com/p?page=2', 'https://example.com/p?page=3'],
    ];

    for (const [left, right] of distinctByQueryOnly) {
      it(`${left} shares no variant with ${right}`, () => {
        const shared = urlVariants(left).filter((variant) => urlVariants(right).includes(variant));
        expect(shared).toEqual([]);
      });
    }
  });
});
