/**
 * The one place the index origin is written in code.
 *
 * `manifest.json`'s `host_permissions` entry has to repeat it as a literal — a
 * manifest cannot reference a constant — so the two drift silently if this moves.
 * Change one, change the other, and nothing else derives an origin of its own.
 */
export const INDEX_ORIGIN = 'https://hn-index.tanner.place';

/** The only other origin the extension ever touches. */
export const HN_ORIGIN = 'https://news.ycombinator.com';
