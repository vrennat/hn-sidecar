/** Anonymous public HTML only. Opening a prefetched thread joins its in-flight GET. */
import { HN_ORIGIN } from '../config.ts';
const prefetched = new Map<number, { html: string; at: number }>();
const inflight = new Map<number, { refresh: boolean; run: Promise<string> }>();
const prefetching = new Map<number, object>();
const TTL_MS = 5 * 60_000;

const fetchHtml = (id: number, refresh = false): Promise<string> => {
  const pending = inflight.get(id);
  if (pending && (!refresh || pending.refresh)) return pending.run;
  const entry = { refresh, run: Promise.resolve('') };
  entry.run = fetch(`${HN_ORIGIN}/item?id=${id}`, {
    credentials: 'omit',
    cache: refresh ? 'reload' : 'default',
    signal: AbortSignal.timeout(20_000),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HN item ${id} -> ${response.status}`);
      return response.text();
    })
    .finally(() => {
      if (inflight.get(id) === entry) inflight.delete(id);
    });
  inflight.set(id, entry);
  return entry.run;
};
export const prefetchThread = async (id: number): Promise<void> => {
  const hit = prefetched.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return;
  const token = {};
  prefetching.set(id, token);
  try {
    const html = await fetchHtml(id);
    if (prefetching.get(id) !== token) return;
    prefetched.set(id, { html, at: Date.now() });
    while (prefetched.size > 2) prefetched.delete(prefetched.keys().next().value!);
  } finally {
    if (prefetching.get(id) === token) prefetching.delete(id);
  }
};
export const takeThread = async (
  id: number,
  refresh = false,
): Promise<{ html: string; prefetched: boolean; fetchedAt: number }> => {
  const hit = prefetched.get(id);
  if (refresh) prefetching.delete(id); // An older prefetch must not retain stale HTML later.
  prefetched.delete(id);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return { html: hit.html, prefetched: true, fetchedAt: hit.at };
  return { html: await fetchHtml(id, refresh), prefetched: false, fetchedAt: Date.now() };
};
