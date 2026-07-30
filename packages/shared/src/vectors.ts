/**
 * Golden test vectors — the contract between the ingest Worker, the regen batch,
 * and the extension.
 *
 * `input` and `normalized` are hand-written assertions about what the algorithm
 * should do; a change to either is a deliberate decision. The corresponding
 * digests live in `frozen.ts`, so that an accidental change to the hash
 * construction (digest input, truncation width, bucket bit selection) fails
 * loudly instead of silently unmatching every client.
 */

export interface GoldenVector {
  readonly why: string;
  readonly input: string;
  /** `null` means the input must be rejected. */
  readonly normalized: string | null;
}

export const GOLDEN_VECTORS: readonly GoldenVector[] = [
  {
    why: 'scheme is dropped so http and https collide',
    input: 'http://example.com/a',
    normalized: 'example.com/a',
  },
  {
    why: 'https form of the same document hashes identically',
    input: 'https://example.com/a',
    normalized: 'example.com/a',
  },
  {
    why: 'www. is a mirror prefix',
    input: 'https://www.example.com/a',
    normalized: 'example.com/a',
  },
  {
    why: 'host case and trailing dot are insignificant',
    input: 'https://EXAMPLE.com./a',
    normalized: 'example.com/a',
  },
  {
    why: 'trailing slash is insignificant',
    input: 'https://example.com/a/',
    normalized: 'example.com/a',
  },
  {
    why: 'root path normalizes to the bare host',
    input: 'https://example.com/',
    normalized: 'example.com',
  },
  {
    why: 'fragment is dropped',
    input: 'https://example.com/a#section-2',
    normalized: 'example.com/a',
  },
  {
    why: 'path case is preserved — paths are case-sensitive',
    input: 'https://example.com/CaseSensitive',
    normalized: 'example.com/CaseSensitive',
  },
  {
    why: 'default port is dropped',
    input: 'https://example.com:443/a',
    normalized: 'example.com/a',
  },
  {
    why: 'non-default port is preserved',
    input: 'https://example.com:8443/a',
    normalized: 'example.com:8443/a',
  },
  {
    why: 'duplicate slashes collapse',
    input: 'https://example.com//a//b',
    normalized: 'example.com/a/b',
  },
  {
    why: 'index files are the same document as the directory',
    input: 'https://example.com/docs/index.html',
    normalized: 'example.com/docs',
  },
  {
    why: 'utm_* is stripped by prefix',
    input: 'https://example.com/a?utm_source=hn&utm_medium=social',
    normalized: 'example.com/a',
  },
  {
    why: 'named trackers are stripped, unknown params are kept',
    input: 'https://example.com/a?fbclid=xyz&id=42&ref=hn',
    normalized: 'example.com/a?id=42',
  },
  {
    why: 'remaining params are sorted so order is insignificant',
    input: 'https://example.com/a?b=2&a=1',
    normalized: 'example.com/a?a=1&b=2',
  },
  {
    why: 'an unknown param is content-selecting and must survive',
    input: 'https://example.com/story?page=3',
    normalized: 'example.com/story?page=3',
  },
  {
    why: 'm. is a mobile mirror',
    input: 'https://m.example.com/a',
    normalized: 'example.com/a',
  },
  {
    why: 'AMP as a trailing path segment',
    input: 'https://example.com/article/amp/',
    normalized: 'example.com/article',
  },
  {
    why: 'AMP as a leading path segment',
    input: 'https://example.com/amp/article',
    normalized: 'example.com/article',
  },
  {
    why: 'AMP as a suffix',
    input: 'https://example.com/article.amp',
    normalized: 'example.com/article',
  },
  {
    why: 'youtu.be short form folds to the watch form',
    input: 'https://youtu.be/dQw4w9WgXcQ',
    normalized: 'youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    why: 'watch form keeps only the video id',
    input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLabc',
    normalized: 'youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    why: 'shorts form is the same video',
    input: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    normalized: 'youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    why: 'a playlist is not a video and must not be folded',
    input: 'https://www.youtube.com/playlist?list=PLabc',
    normalized: 'youtube.com/playlist?list=PLabc',
  },
  {
    why: 'x.com is twitter.com',
    input: 'https://x.com/user/status/123',
    normalized: 'twitter.com/user/status/123',
  },
  {
    why: 'reddit mirrors collapse',
    input: 'https://old.reddit.com/r/programming/comments/abc/title/',
    normalized: 'reddit.com/r/programming/comments/abc/title',
  },
  {
    why: 'a two-label host is never stripped down to a TLD',
    input: 'https://m.co/a',
    normalized: 'm.co/a',
  },
  {
    why: 'non-http schemes are rejected',
    input: 'ftp://example.com/a',
    normalized: null,
  },
  {
    why: 'garbage is rejected rather than coerced',
    input: 'not a url',
    normalized: null,
  },
];
