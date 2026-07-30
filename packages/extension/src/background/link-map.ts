/**
 * Case A — what the extension learns for free from HN's own pages.
 *
 * When the user is looking at a listing, every story's id, URL, title, points and
 * comment count are already in the DOM. Remembering them means that following a link
 * badges the destination with **zero lookups** — nothing leaves the machine at all,
 * and it works before any index exists.
 *
 * Keyed by normalized URL so the destination page's address-bar URL matches the href
 * HN carried. A miss is expected and fine: redirects can land on a URL that normalizes
 * differently, and case B picks those up.
 */

import { normalizeUrl } from '@hn-sidecar/shared';
import type { ListingEntry, Submission } from '../lib/protocol.ts';
import { cacheGet, cacheSet } from './session-cache.ts';

const KEY_PREFIX = 'linkmap:';

/**
 * How long an HN-derived entry stays trusted. Long enough to cover reading a listing
 * and working through its links, short enough that a stale comment count is not shown
 * for the rest of the session.
 */
const TTL_MS = 30 * 60_000;

const toSubmission = (entry: ListingEntry): Submission => ({
  id: entry.id,
  title: entry.title,
  points: entry.points,
  comments: entry.comments,
  ts: entry.ts,
});

export const rememberListing = async (entries: readonly ListingEntry[]): Promise<number> => {
  const grouped = new Map<string, Submission[]>();
  for (const entry of entries) {
    const normalized = normalizeUrl(entry.url);
    if (normalized === null) continue;
    const bucket = grouped.get(normalized) ?? [];
    bucket.push(toSubmission(entry));
    grouped.set(normalized, bucket);
  }

  await Promise.all(
    [...grouped].map(async ([normalized, submissions]) => {
      // Merge rather than replace: a URL can appear on several listings the user
      // visits, and the item page carries a fresher count than the front page did.
      const existing = (await cacheGet<Submission[]>(`${KEY_PREFIX}${normalized}`)) ?? [];
      const byId = new Map<number, Submission>();
      for (const submission of [...existing, ...submissions]) {
        const previous = byId.get(submission.id);
        if (previous !== undefined && previous.comments >= submission.comments) continue;
        byId.set(submission.id, submission);
      }
      await cacheSet(`${KEY_PREFIX}${normalized}`, [...byId.values()], TTL_MS);
    }),
  );

  return grouped.size;
};

export const lookupLinkMap = async (url: string): Promise<Submission[] | null> => {
  const normalized = normalizeUrl(url);
  if (normalized === null) return null;
  const hit = await cacheGet<Submission[]>(`${KEY_PREFIX}${normalized}`);
  if (hit === null || hit.length === 0) return null;
  return [...hit].sort((left, right) => right.comments - left.comments);
};
