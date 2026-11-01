/**
 * The shapes that cross a context boundary: content script -> background,
 * panel <-> background. Everything here has to survive structured cloning, so no
 * DOM nodes, no class instances, no `undefined` in required positions.
 */

/** One HN submission of one URL. Several per URL is the "discussed 4 times" case. */
export interface Submission {
  readonly id: number;
  readonly title: string;
  readonly points: number;
  readonly comments: number;
  /** Unix seconds. */
  readonly ts: number;
}

/**
 * Where a finding came from, which the panel shows because the two paths have
 * genuinely different privacy properties and different freshness.
 */
export type FindingSource =
  /** Read off the DOM of an HN page the user was already on. No lookup happened. */
  | 'hn-dom'
  /** A 14-bit shard fetch. */
  | 'index'
  /** Looked up, nothing matched. */
  | 'none'
  /** The user is on HN. There is nothing to discover; they are already in the discussion. */
  | 'on-hn'
  /** The URL has no normal form (not http(s), or no host). No lookup was attempted. */
  | 'unhashable'
  /** The published index declares a NORM_VERSION this build does not implement. */
  | 'version-skew'
  /** The lookup itself failed — offline, blocked, malformed artifact. */
  | 'error';

export interface Finding {
  readonly url: string;
  readonly normalized: string | null;
  readonly source: FindingSource;
  /** Deduped by story id, highest comment count first. */
  readonly submissions: readonly Submission[];
  readonly totalComments: number;
  readonly checkedAt: number;
  /** Present when `source` is `error` or `version-skew`. */
  readonly detail?: string;
}

/** A row scraped from an HN listing or item page. */
export interface ListingEntry {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly points: number;
  readonly comments: number;
  readonly ts: number;
}

export type Request =
  | { readonly type: 'hn-listing'; readonly entries: readonly ListingEntry[] }
  | { readonly type: 'prefetch-thread'; readonly id: number }
  /**
   * The panel names the tab it is asking about rather than letting the worker resolve
   * "the active tab" independently: two resolutions of the active tab can disagree
   * mid-switch, and the panel is the one that has to stay consistent with what it drew.
   */
  | { readonly type: 'get-finding'; readonly tabId: number; readonly refresh?: boolean }
  | { readonly type: 'get-thread-html'; readonly id: number; readonly refresh?: boolean };

export type ThreadHtmlResponse =
  | { readonly ok: true; readonly html: string; readonly prefetched: boolean; readonly fetchedAt?: number }
  | { readonly ok: false; readonly error: string };

export const emptyFinding = (url: string, source: FindingSource, detail?: string): Finding => ({
  url,
  normalized: null,
  source,
  submissions: [],
  totalComments: 0,
  checkedAt: Date.now(),
  ...(detail === undefined ? {} : { detail }),
});
