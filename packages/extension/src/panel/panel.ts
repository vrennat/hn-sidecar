/** Panel owns DOM parsing; the MV3 worker owns anonymous cross-origin requests. */
import { type Finding, type Request, type Submission, type ThreadHtmlResponse } from '../lib/protocol.ts';
import { parseThread } from '../lib/thread.ts';
import { readThread, writeThread, type CachedThread } from '../lib/thread-cache.ts';
import { HN_ORIGIN } from '../config.ts';
import { hnLink, renderThread } from './thread-view.ts';

const statusEl = document.querySelector<HTMLElement>('#status');
const listEl = document.querySelector<HTMLElement>('#submissions');
const refreshEl = document.querySelector<HTMLButtonElement>('#refresh');
const checkedEl = document.querySelector<HTMLElement>('#checked');
const detailEl = document.querySelector<HTMLElement>('#detail');
const ask = async <T>(message: Request): Promise<T | null> => {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return null;
  }
};
const setStatus = (text: string): void => {
  if (statusEl) statusEl.textContent = text;
};
const timestamp = (at: number): string => {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const describe = (finding: Finding): string => {
  switch (finding.source) {
    case 'unhashable':
      return 'Open an article on an HTTP or HTTPS website to check for discussions.';
    case 'error':
      return 'Couldn’t check this page. Check your connection and try again.';
    case 'version-skew':
      return 'The index needs a newer extension. Update HN Sidecar in Chrome.';
    case 'on-hn':
      return 'Open an article from Hacker News; its discussion will follow you here.';
    case 'none':
      return 'No discussion found in Sidecar’s index. New submissions can take a few minutes.';
    default:
      return `${finding.submissions.length} ${finding.submissions.length === 1 ? 'discussion' : 'discussions'} · ${finding.totalComments} comments${finding.source === 'hn-dom' ? ' · from this session’s HN pages' : ''}`;
  }
};
const loadThread = async (
  id: number,
  refresh: boolean,
): Promise<CachedThread & { cached: boolean; persist: boolean }> => {
  const cached = refresh ? null : await readThread(id);
  if (cached) return { ...cached, cached: true, persist: false };
  const response = await ask<ThreadHtmlResponse>({ type: 'get-thread-html', id, refresh });
  let html: string;
  let fetchedAt = Date.now();
  if (response?.ok) {
    html = response.html;
    fetchedAt = response.fetchedAt ?? fetchedAt;
  } else if (response && !response.ok) throw new Error(response.error);
  else {
    // Worker unavailable, not a second attempt after a known HTTP failure.
    const direct = await fetch(`${HN_ORIGIN}/item?id=${id}`, {
      credentials: 'omit',
      cache: refresh ? 'reload' : 'default',
      signal: AbortSignal.timeout(20_000),
    });
    if (!direct.ok) throw new Error(`HN item ${id} -> ${direct.status}`);
    html = await direct.text();
    fetchedAt = Date.now();
  }
  return { html, fetchedAt, cached: response?.ok === true && response.prefetched, persist: true };
};

interface SubmissionView {
  element: HTMLElement;
  dispose(): void;
}
const buildSubmission = (
  submission: Submission,
  expanded: boolean,
  update: (comments: number) => void,
): SubmissionView => {
  const element = document.createElement('section');
  element.className = 'submission';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'head';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = submission.title;
  const facts = document.createElement('span');
  facts.className = 'facts';
  const date = new Date(submission.ts * 1000).toISOString().slice(0, 10);
  const setFacts = (comments: number, points: number): void => {
    facts.textContent = `${comments} comments · ${points} points · ${date}`;
  };
  setFacts(submission.comments, submission.points);
  head.append(title, facts);
  const thread = document.createElement('div');
  thread.className = 'thread';
  thread.id = `thread-${submission.id}`;
  const controls = document.createElement('div');
  controls.className = 'thread-controls';
  const freshness = document.createElement('span');
  freshness.className = 'notice';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Refresh comments';
  retry.setAttribute('aria-label', `Refresh comments for ${submission.title}`);
  controls.append(freshness, retry, hnLink(submission.id, 'Open on HN'));
  const body = document.createElement('div');
  thread.append(controls, body);
  head.setAttribute('aria-controls', thread.id);
  head.setAttribute('aria-expanded', String(expanded));
  thread.hidden = !expanded;
  element.append(head, thread);
  let loaded = false,
    loading = false,
    disposed = false;
  let disconnect = () => {};
  const load = async (refresh = false): Promise<void> => {
    if (loading || disposed) return;
    loading = true;
    retry.disabled = true;
    body.setAttribute('aria-busy', 'true');
    freshness.textContent = 'Loading comments…';
    try {
      const result = await loadThread(submission.id, refresh);
      if (disposed) return;
      const parsed = parseThread(result.html, submission.id);
      if (parsed.title === null && parsed.rows.length === 0) throw new Error('HN returned an unrecognized page');
      if (result.persist && (parsed.rows.length > 0 || parsed.comments === 0)) {
        void writeThread(submission.id, result.html, submission.ts, result.fetchedAt);
      }
      disconnect();
      disconnect = renderThread(parsed, body);
      loaded = true;
      freshness.textContent = `${result.cached ? 'Cached' : 'Updated'} ${timestamp(result.fetchedAt)}`;
      freshness.title = new Date(result.fetchedAt).toISOString();
      retry.textContent = 'Refresh comments';
      setFacts(parsed.comments ?? submission.comments, parsed.points ?? submission.points);
      if (parsed.comments !== null) update(parsed.comments);
    } catch (error) {
      if (disposed) return;
      freshness.textContent = loaded
        ? 'Couldn’t refresh. Showing earlier comments.'
        : 'Couldn’t load comments. Try again or open HN.';
      freshness.title = error instanceof Error ? error.message : String(error);
      retry.textContent = 'Retry';
    } finally {
      loading = false;
      retry.disabled = false;
      body.removeAttribute('aria-busy');
    }
  };
  head.addEventListener('click', () => {
    thread.hidden = !thread.hidden;
    head.setAttribute('aria-expanded', String(!thread.hidden));
    if (!thread.hidden && !loaded) void load();
  });
  retry.addEventListener('click', () => void load(true));
  if (expanded) void load();
  return {
    element,
    dispose() {
      disposed = true;
      disconnect();
    },
  };
};

let seq = 0;
let querySeq = 0;
let forceRequested = false;
let inFlight: { tabId: number; url: string; refresh: boolean } | null = null;
let observedTabId: number | null = null;
let viewRevision = 0;
let counts = new Map<number, number>();
let shown: { tabId: number; url: string; finding: Finding } | null = null;
let views: SubmissionView[] = [];
const clear = (): void => {
  ++viewRevision;
  counts.clear();
  for (const view of views) view.dispose();
  views = [];
  listEl?.replaceChildren();
};
const render = async (refresh = false, recheck = false): Promise<void> => {
  // Preserve an explicit click if another tab query overtakes this one.
  if (refresh) {
    forceRequested = true;
    if (refreshEl) refreshEl.disabled = true;
  }
  const query = ++querySeq;
  let request = 0;
  const current = (): boolean => request !== 0 && request === seq;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (query !== querySeq) return;
    refresh ||= forceRequested;
    observedTabId = tab?.id ?? null;
    const url = tab?.url ?? '';
    if (tab?.id === undefined) {
      request = ++seq;
      forceRequested = false;
      inFlight = null;
      clear();
      shown = null;
      setStatus('No active page to check.');
      return;
    }
    if (inFlight?.tabId === tab.id && inFlight.url === url && (!refresh || inFlight.refresh)) {
      if (inFlight.refresh) forceRequested = false;
      return;
    }
    const samePage = shown?.tabId === tab.id && shown.url === url;
    if (samePage && !refresh && !recheck) return;
    request = ++seq;
    forceRequested = false;
    inFlight = { tabId: tab.id, url, refresh };
    if (!samePage) {
      clear();
      shown = null;
      if (checkedEl) checkedEl.textContent = '';
      if (detailEl) {
        detailEl.hidden = true;
        detailEl.textContent = '';
      }
    }
    setStatus('Checking this page…');
    listEl?.setAttribute('aria-busy', 'true');
    if (refreshEl) refreshEl.disabled = true;
    const finding = await ask<Finding | null>({ type: 'get-finding', tabId: tab.id, refresh });
    if (!current()) return;
    if (!finding || finding.url !== url) {
      setStatus('Couldn’t check this page. Try again.');
      if (refreshEl) refreshEl.textContent = 'Retry';
      return;
    }
    if (detailEl) {
      detailEl.textContent = finding.detail ?? '';
      detailEl.hidden = !finding.detail;
    }
    if (refreshEl) refreshEl.textContent = finding.source === 'error' ? 'Retry' : 'Check again';
    if (checkedEl) {
      checkedEl.textContent = `Checked ${timestamp(finding.checkedAt)}`;
      checkedEl.title = new Date(finding.checkedAt).toISOString();
    }
    // A failed refresh must not destroy an already readable thread.
    if (samePage && shown && (finding.source === 'error' || finding.source === 'version-skew')) {
      setStatus(`${describe(finding)} Showing earlier results.`);
      return;
    }
    const previous = shown?.finding;
    // Equal submissions: retain scroll position and collapsed/open comment state.
    const unchanged =
      samePage && previous && JSON.stringify(previous.submissions) === JSON.stringify(finding.submissions);
    shown = { tabId: tab.id, url, finding };
    if (!unchanged) {
      clear();
      counts = new Map(finding.submissions.map((s) => [s.id, s.comments]));
      const revision = viewRevision;
      views = [...finding.submissions]
        .sort((a, b) => b.ts - a.ts)
        .map((submission, index) =>
          buildSubmission(submission, index === 0, (comments) => {
            if (viewRevision !== revision || !shown) return;
            counts.set(submission.id, comments);
            setStatus(describe({ ...shown.finding, totalComments: [...counts.values()].reduce((a, b) => a + b, 0) }));
          }),
        );
      listEl?.append(...views.map((view) => view.element));
    }
    setStatus(describe({ ...finding, totalComments: [...counts.values()].reduce((a, b) => a + b, 0) }));
  } catch (error) {
    if (!request && query === querySeq) request = ++seq;
    if (current()) {
      setStatus('Couldn’t check this page. Try again.');
      if (detailEl) detailEl.textContent = String(error);
    }
  } finally {
    if (current()) {
      inFlight = null;
      listEl?.removeAttribute('aria-busy');
      if (refreshEl) refreshEl.disabled = false;
    }
  }
};
refreshEl?.addEventListener('click', () => void render(true));
window.addEventListener('pagehide', () => {
  ++seq;
  ++querySeq;
  clear();
});
chrome.tabs.onActivated.addListener(() => void render());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if ((observedTabId === null || tabId === observedTabId) && info.status === 'complete') void render(false, true);
});
void render();
