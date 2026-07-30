/**
 * The only place that fetches thread HTML from HN.
 *
 * `credentials: 'omit'` is the point: the user's HN cookie is never sent, so HN sees
 * an anonymous request for a public page — a page view the user was about to generate
 * anyway. It also means we get the logged-out view, which is what the
 * parser was written against.
 *
 * The prefetch map is deliberately tiny and deliberately in memory. MV3 terminates the
 * worker after ~30 s idle, so a prefetch triggered by `mousedown` will *often* be gone
 * before the panel opens — that is correct eviction, not a bug, and every caller must
 * treat a miss as normal and fetch.
 */

import { HN_ORIGIN } from '../config.ts';

const PREFETCH_CAPACITY = 2;
const PREFETCH_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface Prefetched {
  readonly html: string;
  readonly at: number;
}

const prefetched = new Map<number, Prefetched>();

const fetchThreadHtml = async (id: number): Promise<string> => {
  const response = await fetch(`${HN_ORIGIN}/item?id=${id}`, {
    credentials: 'omit',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HN item ${id} -> ${response.status}`);
  return await response.text();
};

export const prefetchThread = async (id: number): Promise<void> => {
  if (prefetched.has(id)) return;
  const html = await fetchThreadHtml(id);
  prefetched.set(id, { html, at: Date.now() });
  while (prefetched.size > PREFETCH_CAPACITY) {
    const oldest = prefetched.keys().next();
    if (oldest.done === true) break;
    prefetched.delete(oldest.value);
  }
};

export const takeThread = async (id: number): Promise<{ html: string; prefetched: boolean }> => {
  const hit = prefetched.get(id);
  if (hit !== undefined && Date.now() - hit.at < PREFETCH_TTL_MS) {
    prefetched.delete(id);
    return { html: hit.html, prefetched: true };
  }
  prefetched.delete(id);
  return { html: await fetchThreadHtml(id), prefetched: false };
};
