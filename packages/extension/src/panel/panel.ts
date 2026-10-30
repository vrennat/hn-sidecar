/**
 * The side panel: what the badge's number turns out to mean.
 *
 * The panel does the parsing rather than the service worker for a hard reason: MV3
 * service workers have no `DOMParser`. It asks the worker for the HTML instead of
 * fetching directly, because the `mousedown` prefetch lands in the *worker's* memory —
 * going through it is the only way that prefetch is worth anything. A direct fetch is
 * kept as the fallback for when the worker cannot answer.
 */

import type { Finding, Request, Submission, ThreadHtmlResponse } from '../lib/protocol.ts';
import { parseThread } from '../lib/thread.ts';
import { readThread, writeThread } from '../lib/thread-cache.ts';
import { HN_ORIGIN } from '../config.ts';
import { hnLink, renderThread } from './thread-view.ts';

const statusEl = document.querySelector<HTMLParagraphElement>('#status');
const listEl = document.querySelector<HTMLElement>('#submissions');

const ask = async <T>(message: Request): Promise<T | null> => {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return null;
  }
};

const setStatus = (text: string): void => {
  if (statusEl !== null) statusEl.textContent = text;
};

const yearsOf = (submissions: readonly Submission[]): string => {
  const years = [...new Set(submissions.map((s) => new Date(s.ts * 1000).getUTCFullYear()))].sort();
  return years.join(', ');
};

const describe = (finding: Finding): string => {
  switch (finding.source) {
    case 'unhashable':
      return 'This page has no address HN could have been given.';
    case 'error':
      return `Lookup failed — ${finding.detail ?? 'unknown error'}. This is not the same as "no discussion".`;
    case 'version-skew':
      return `The published index does not match this build (${finding.detail ?? ''}). Update the extension.`;
    case 'on-hn':
      return 'You are on Hacker News — nothing to look up here. Open a story and the badge follows you.';
    case 'none':
      return 'No HN discussion found for this page.';
    case 'hn-dom':
    case 'index': {
      const count = finding.submissions.length;
      const times = count === 1 ? 'Discussed once' : `Discussed ${count} times`;
      const via = finding.source === 'hn-dom' ? ' · read from HN, no lookup' : '';
      return `${times} — ${yearsOf(finding.submissions)} · ${finding.totalComments} comments total${via}`;
    }
    default:
      return '';
  }
};

/** IndexedDB first, then the worker (which may be holding a prefetch), then direct. */
const loadThreadHtml = async (id: number, storyTs: number): Promise<string> => {
  const cached = await readThread(id);
  if (cached !== null) return cached;

  const response = await ask<ThreadHtmlResponse>({ type: 'get-thread-html', id });
  if (response !== null && response.ok) {
    void writeThread(id, response.html, storyTs);
    return response.html;
  }

  const direct = await fetch(`${HN_ORIGIN}/item?id=${id}`, {
    credentials: 'omit',
    signal: AbortSignal.timeout(20_000),
  });
  if (!direct.ok) throw new Error(`HN item ${id} -> ${direct.status}`);
  const html = await direct.text();
  void writeThread(id, html, storyTs);
  return html;
};

const buildSubmission = (submission: Submission, startExpanded: boolean): HTMLElement => {
  const container = document.createElement('section');
  container.className = 'submission';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'head';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = submission.title;
  const facts = document.createElement('span');
  facts.className = 'facts';
  const date = new Date(submission.ts * 1000).toISOString().slice(0, 10);
  facts.textContent = `${submission.comments} comments · ${submission.points} points · ${date}`;
  head.append(title, facts);

  const thread = document.createElement('div');
  thread.className = 'thread';
  thread.id = `thread-${submission.id}`;
  thread.hidden = true;
  head.setAttribute('aria-controls', thread.id);
  head.setAttribute('aria-expanded', 'false');

  let loaded = false;
  const expand = (): void => {
    loaded = true;
    thread.hidden = false;
    head.setAttribute('aria-expanded', 'true');
    const loading = document.createElement('p');
    loading.className = 'notice';
    loading.textContent = 'Loading thread…';
    thread.append(loading);
    void loadThreadHtml(submission.id, submission.ts).then(
      (html) => {
        const parsed = parseThread(html, submission.id);
        renderThread(parsed, thread);
        // The index's counts for this story can be stale — score/descendants are
        // captured at ingest and refreshed only lazily — while the item page just
        // fetched is authoritative. Correct the head line to what the thread shows.
        if (parsed.comments !== null || parsed.points !== null) {
          facts.textContent = `${parsed.comments ?? submission.comments} comments · ${parsed.points ?? submission.points} points · ${date}`;
        }
      },
      (error: unknown) => {
        thread.textContent = '';
        const failed = document.createElement('p');
        failed.className = 'notice';
        failed.textContent = `Could not load the thread (${error instanceof Error ? error.message : String(error)}).`;
        const link = hnLink(submission.id, 'Open it on HN');
        link.className = 'footer-link';
        thread.append(failed, link);
      },
    );
  };

  head.addEventListener('click', () => {
    if (!loaded) {
      expand();
      return;
    }
    thread.hidden = !thread.hidden;
    head.setAttribute('aria-expanded', String(!thread.hidden));
  });

  // The most recent discussion opens expanded: it is what the badge's number almost
  // always means, and the IndexedDB/worker cache keeps it cheap on repeat views.
  if (startExpanded) expand();

  container.append(head, thread);
  return container;
};

/**
 * What the panel is currently showing.
 *
 * Rebuilding the list throws away an open thread — the parsed rows, the scroll position,
 * every collapse the user has made. So the rebuild is guarded on the page actually having
 * changed, not on an event having fired: `tabs.onUpdated` fires for *every* tab in the
 * browser, and re-rendering on a background tab's load would collapse the 2,000-comment
 * thread the user is reading. Switching tabs away and back must not do it either.
 */
let shownTabId: number | null = null;
let shownUrl: string | null = null;

const render = async (): Promise<void> => {
  if (listEl === null) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    setStatus('No page to check.');
    listEl.textContent = '';
    shownTabId = null;
    shownUrl = null;
    return;
  }
  if (tab.id === shownTabId && (tab.url ?? null) === shownUrl) return;

  const finding = await ask<Finding | null>({ type: 'get-finding', tabId: tab.id });
  shownTabId = tab.id;
  shownUrl = tab.url ?? null;

  if (finding === null) {
    setStatus('No page to check.');
    listEl.textContent = '';
    return;
  }

  setStatus(describe(finding));
  listEl.textContent = '';
  const fragment = document.createDocumentFragment();
  // Most recent first, top one expanded: the panel's default view is the discussion
  // the user most likely opened it for. Display order only — the finding's own
  // ordering (comment count, used by the badge) is unchanged.
  const ordered = [...finding.submissions].sort((left, right) => right.ts - left.ts);
  ordered.forEach((submission, index) => fragment.append(buildSubmission(submission, index === 0)));
  listEl.append(fragment);
};

void render();

chrome.tabs.onActivated.addListener(() => void render());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Only the tab being shown, and only once it has settled.
  if (tabId !== shownTabId || info.status !== 'complete') return;
  void render();
});
