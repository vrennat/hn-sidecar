/**
 * Turning shard entries into submissions. Pure, and tested, because the dedupe here is
 * load-bearing for the badge rather than tidiness.
 *
 * Several entries can legitimately share one `h`: resubmissions of the same URL are the
 * whole "discussed 4 times" feature. But the same *story id* can also appear more than
 * once in a merged set — `recent.json` and the shard overlap for anything posted in the
 * last 48 h — and summing `c` across those would inflate the badge with no visible
 * symptom at all. Highest comment count wins, being the fresher observation.
 */

import type { ShardEntry } from '@hn-sidecar/shared';
import type { Submission } from './protocol.ts';

export const toSubmissions = (entries: readonly ShardEntry[], h: string): Submission[] => {
  const byId = new Map<number, Submission>();
  for (const entry of entries) {
    if (entry.h !== h) continue;
    const existing = byId.get(entry.id);
    if (existing !== undefined && existing.comments >= entry.c) continue;
    byId.set(entry.id, { id: entry.id, title: entry.t, points: entry.p, comments: entry.c, ts: entry.ts });
  }
  return [...byId.values()].sort((left, right) => right.comments - left.comments);
};

export const totalComments = (submissions: readonly Submission[]): number =>
  submissions.reduce((sum, submission) => sum + submission.comments, 0);
