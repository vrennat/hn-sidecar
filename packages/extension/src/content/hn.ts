/**
 * Content script on news.ycombinator.com.
 *
 * Two jobs, both read-only against the page:
 *
 * 1. Hand the background worker every story id and URL on this page, so following a
 *    link badges the destination with no lookup at all.
 * 2. On `mousedown` on a story link, ask for that thread to be prefetched.
 *
 * `mousedown`, not hover: hover-prefetch would send HN a request for every thread the
 * pointer crosses, which is more traffic than the user's own browsing generates.
 * `mousedown` fires on real intent, and it fires early enough to win the race against
 * the destination page rendering.
 */

import type { ListingEntry, Request } from '../lib/protocol.ts';

const send = (message: Request): void => {
  // The worker may be asleep; a rejected send is not worth surfacing to the page.
  void chrome.runtime.sendMessage(message).catch(() => undefined);
};

const parseCount = (text: string | null | undefined, pattern: RegExp): number => {
  if (text === null || text === undefined) return 0;
  const match = pattern.exec(text.replace(/ /g, ' '));
  const digits = match?.[1];
  return digits === undefined ? 0 : Number.parseInt(digits, 10);
};

/** `title` is `"2023-11-17T20:28:50 1700252930"`; the unix half is what we want. */
const parseAge = (row: Element): number => {
  const title = row.querySelector('span.age')?.getAttribute('title') ?? '';
  const unix = / (\d{9,})$/.exec(title)?.[1];
  if (unix !== undefined) return Number.parseInt(unix, 10);
  const iso = title.split(' ')[0];
  const parsed = iso === undefined ? Number.NaN : Date.parse(`${iso}Z`);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
};

/**
 * `tr.athing` also matches every comment row on an item page, and a comment's id is
 * not a story id — hence `:not(.comtr)`. On an item page the one match left is the
 * story itself, which is exactly the row we want.
 */
const collect = (): ListingEntry[] => {
  const entries: ListingEntry[] = [];
  for (const row of document.querySelectorAll('tr.athing:not(.comtr)')) {
    const id = Number.parseInt(row.id, 10);
    const link = row.querySelector<HTMLAnchorElement>('.titleline > a');
    const href = link?.href;
    if (!Number.isFinite(id) || href === undefined || !/^https?:/.test(href)) continue;

    // The subtext row is the story row's sibling and carries points and comment count.
    const subtext = row.nextElementSibling?.querySelector('.subtext');
    entries.push({
      id,
      url: href,
      title: link?.textContent?.trim() ?? '',
      points: parseCount(subtext?.querySelector('.score')?.textContent, /(\d+)\s*points?/),
      comments: parseCount(subtext?.textContent, /(\d+)\s*comments?/),
      ts: parseAge(row.nextElementSibling ?? row),
    });
  }
  return entries;
};

const report = (): void => {
  const entries = collect();
  if (entries.length > 0) send({ type: 'hn-listing', entries });
};

report();

/**
 * HN pages are server-rendered and static, but "more" links and the occasional
 * in-place update mean the row set can change without a navigation. One observer,
 * debounced, is cheaper than re-scraping on a timer.
 */
let pending: number | undefined;
new MutationObserver(() => {
  if (pending !== undefined) clearTimeout(pending);
  pending = setTimeout(report, 500) as unknown as number;
}).observe(document.body, { childList: true, subtree: true });

document.addEventListener(
  'mousedown',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a');
    // Only the story's own outbound link. The "N comments" link goes to HN, where the
    // thread is the page the user is about to read anyway.
    if (link === null || link.parentElement?.classList.contains('titleline') !== true) return;
    const row = link.closest('tr.athing:not(.comtr)');
    if (row === null) return;
    const id = Number.parseInt(row.id, 10);
    if (Number.isFinite(id)) send({ type: 'prefetch-thread', id });
  },
  { capture: true, passive: true },
);
