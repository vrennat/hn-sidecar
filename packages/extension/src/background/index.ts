/**
 * MV3 service worker: decides which of the two paths a navigation takes, keeps the
 * per-tab finding, and answers the panel.
 *
 * Every listener is registered synchronously at top level. An MV3 worker is started
 * *by* an event, so a listener attached inside a promise callback can miss the very
 * event that woke the worker.
 */

import { HN_ORIGIN } from '../config.ts';
import { emptyFinding, type Finding, type Request, type ThreadHtmlResponse } from '../lib/protocol.ts';
import { totalComments } from '../lib/submissions.ts';
import { applyBadge } from './badge.ts';
import { lookupLinkMap, rememberListing } from './link-map.ts';
import { lookupUrl } from './lookup.ts';
import { cacheDelete, cacheGet, cacheSet } from './session-cache.ts';
import { prefetchThread, takeThread } from './thread-source.ts';

const FINDING_TTL_MS = 30 * 60_000;
const findingKey = (tabId: number): string => `finding:${tabId}`;

const isHn = (url: string): boolean => url.startsWith(`${HN_ORIGIN}/`);

/**
 * One lookup per tab at a time, joined by anyone who asks while it runs.
 *
 * A navigation triggers `tabs.onUpdated` *and* usually a `get-finding` from the panel
 * before the first lookup has settled; without this, both run `handleNavigation`
 * concurrently and every artifact fetch happens twice. Keyed on URL as well as tab:
 * a second navigation mid-lookup must not join a promise that is answering about the
 * page the user has already left.
 *
 * Each entry also carries a `seq`: when a tab navigates again while a lookup is still
 * fetching, `navigate` starts a new run and bumps the seq. The superseded run uses
 * `isCurrent` to detect that it is stale and skips its badge/cache writes — otherwise
 * the slower lookup for the page the user left would land last and overwrite the
 * current page's badge (last writer wins, and the last writer is the stale one).
 */
const navigating = new Map<
  number,
  {
    readonly url: string | undefined;
    readonly seq: number;
    readonly refresh: boolean;
    readonly run: Promise<Finding | null>;
  }
>();

let nextSeq = 1;

/**
 * True iff `seq` is still the latest lookup started for `tabId`.
 *
 * Module-scoped, so this is exact within one service-worker lifetime — no IPC, no
 * time-of-check/time-of-use gap. A newer `navigate` for the same tab bumps the seq
 * synchronously before its first `await`, which is the only moment that matters.
 */
const isCurrent = (tabId: number, seq: number): boolean => navigating.get(tabId)?.seq === seq;

const navigate = (tabId: number, url: string | undefined, refresh = false): Promise<Finding | null> => {
  const pending = navigating.get(tabId);
  if (pending !== undefined && pending.url === url && (!refresh || pending.refresh)) return pending.run;
  const seq = nextSeq++;
  const run = Promise.resolve()
    .then(() => handleNavigation(tabId, url, seq, refresh))
    .finally(() => {
      if (isCurrent(tabId, seq)) navigating.delete(tabId);
    });
  navigating.set(tabId, { url, seq, refresh, run });
  return run;
};

const handleNavigation = async (
  tabId: number,
  url: string | undefined,
  seq: number,
  refresh: boolean,
): Promise<Finding | null> => {
  if (url === undefined || !/^https?:/.test(url)) {
    if (isCurrent(tabId, seq)) await applyBadge(tabId, null, () => isCurrent(tabId, seq));
    return emptyFinding(url ?? '', 'unhashable');
  }

  /**
   * On HN itself there is nothing to discover — the user is already looking at the
   * discussion. Case A's value is what the page teaches us about *other* URLs, and the
   * content script handles that.
   *
   * This is recorded as a finding rather than left blank because the panel has to say
   * something true here. Opening HN and clicking the icon is the first thing anyone does,
   * and "this page has no address HN could have been given" reads as a broken extension.
   */
  if (isHn(url)) {
    const finding = emptyFinding(url, 'on-hn');
    if (!isCurrent(tabId, seq)) return finding;
    await cacheSet(findingKey(tabId), finding, FINDING_TTL_MS);
    if (!isCurrent(tabId, seq)) return finding;
    await applyBadge(tabId, finding, () => isCurrent(tabId, seq));
    return finding;
  }

  const known = refresh ? null : await lookupLinkMap(url);
  const finding: Finding =
    known !== null
      ? {
          url,
          normalized: null,
          source: 'hn-dom',
          submissions: known,
          totalComments: totalComments(known),
          checkedAt: Date.now(),
        }
      : await lookupUrl(url, refresh);

  // A navigation can supersede this result during any awaited browser operation.
  if (!isCurrent(tabId, seq)) return finding;

  await cacheSet(
    findingKey(tabId),
    finding,
    finding.source === 'error' ? 15_000 : finding.source === 'none' ? 60_000 : FINDING_TTL_MS,
  );
  if (!isCurrent(tabId, seq)) return finding;
  await applyBadge(tabId, finding, () => isCurrent(tabId, seq));
  return finding;
};

chrome.runtime.onInstalled.addListener(() => {
  // Without this the action click does nothing: the panel needs a user gesture and
  // this is what makes the toolbar click count as one.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  void navigate(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  navigating.delete(tabId);
  void cacheDelete(findingKey(tabId));
});

chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
  switch (message.type) {
    case 'hn-listing': {
      void rememberListing(message.entries).then(() => sendResponse({ ok: true }));
      return true;
    }
    case 'prefetch-thread': {
      // Best effort by construction: a failed prefetch just means the panel fetches.
      void prefetchThread(message.id).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    case 'get-finding': {
      const tabId = message.tabId;
      void (async (): Promise<void> => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const url = tab?.url ?? undefined;
        // The cache is keyed by tab, not page: after a navigation it still holds the
        // *previous* page's finding until the new lookup lands. Answering with it
        // would show one page's discussions under another's URL, so a URL mismatch is
        // a miss. The mismatch path also starts the lookup — often ahead of
        // `tabs.onUpdated` 'complete', which is a free head start.
        const cached = await cacheGet<Finding>(findingKey(tabId));
        if (!message.refresh && cached !== null && cached.url === url) {
          sendResponse(cached);
          return;
        }
        // The worker may have been started by the panel opening, after the navigation
        // that would have populated this was handled by a worker that has since died.
        sendResponse(await navigate(tabId, url, message.refresh));
      })().catch((error: unknown) => sendResponse(emptyFinding('', 'error', String(error))));
      return true;
    }
    case 'get-thread-html': {
      void takeThread(message.id, message.refresh).then(
        (result) => sendResponse({ ok: true, ...result } satisfies ThreadHtmlResponse),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ThreadHtmlResponse),
      );
      return true;
    }
    default:
      return false;
  }
});
