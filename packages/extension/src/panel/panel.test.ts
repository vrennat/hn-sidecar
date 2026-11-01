import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window, type HTMLButtonElement as HappyButton, type HTMLAnchorElement as HappyAnchor } from 'happy-dom';
import { IDBFactory } from 'fake-indexeddb';
import { emptyFinding, type Finding } from '../lib/protocol.ts';

let serial = 0;
let window: Window;
let saved: Record<string, unknown>;
let active: { id: number; url: string };
let activated: () => void;
let updated: (id: number, info: { status: string }) => void;
let respond: (message: any) => Promise<unknown>;
let messages: any[];
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const status = () => window.document.querySelector('#status')!.textContent;
const refreshButton = () => window.document.querySelector<HappyButton>('#refresh')!;
const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const noComments =
  '<table><tr><td class="titleline"><a href="https://example.org">Story</a></td></tr><tr><td class="subtext"><span class="score">2 points</span><a>discuss</a></td></tr></table>';
const withComments = noComments.replace('discuss', '2 comments');
const found = (url: string): Finding => ({
  ...emptyFinding(url, 'index'),
  totalComments: 2,
  submissions: [{ id: 999, title: 'Story', comments: 2, points: 2, ts: 1793550000 }],
});
const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('UI did not settle');
};
const start = async () => {
  await import(`./panel.ts?test=${++serial}`);
  await settle();
  if (window.document.querySelector('.thread')) {
    await waitFor(() => !window.document.querySelector('.thread .notice')?.textContent?.includes('Loading'));
  }
};
beforeEach(() => {
  saved = Object.fromEntries(
    ['window', 'document', 'Node', 'DOMParser', 'chrome', 'indexedDB', 'fetch'].map((key) => [
      key,
      (globalThis as any)[key],
    ]),
  );
  window = new Window({ url: 'https://extension-fixture.invalid/panel.html' });
  window.document.body.innerHTML =
    '<p id="status">Checking this page…</p><button id="refresh">Check again</button><p id="checked"></p><p id="detail" hidden></p><main id="submissions"></main>';
  active = { id: 1, url: 'https://example.org/a' };
  messages = [];
  respond = async (message) =>
    message.type === 'get-thread-html'
      ? { ok: true, html: noComments, prefetched: false, fetchedAt: Date.now() }
      : emptyFinding(active.url, 'none');
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    DOMParser: window.DOMParser,
    indexedDB: new IDBFactory(),
    fetch: async () => {
      throw new Error('unexpected direct fetch');
    },
    chrome: {
      tabs: {
        query: async () => [active],
        onActivated: {
          addListener(fn: typeof activated) {
            activated = fn;
          },
        },
        onUpdated: {
          addListener(fn: typeof updated) {
            updated = fn;
          },
        },
      },
      runtime: {
        sendMessage(message: any) {
          messages.push(message);
          return respond(message);
        },
      },
    },
  });
});
afterEach(async () => {
  window.dispatchEvent(new window.Event('pagehide'));
  await settle();
  Object.assign(globalThis, saved);
  window.close();
});

test('a slow result for an old tab cannot overwrite the active tab, including pending navigation', async () => {
  const a = pending<Finding>();
  const b = pending<Finding>();
  respond = (message) => (message.tabId === 1 ? a.promise : b.promise);
  await start();
  active = { id: 2, url: 'https://example.org/b' };
  activated();
  await settle();
  expect(status()).toBe('Checking this page…');
  b.resolve(emptyFinding(active.url, 'error', 'B error'));
  await settle();
  expect(window.document.querySelector('#detail')!.textContent).toBe('B error');
  a.resolve(emptyFinding('https://example.org/a', 'error', 'A error'));
  await settle();
  expect(window.document.querySelector('#detail')!.textContent).toBe('B error');
  expect(refreshButton().disabled).toBe(false);
});
test('same-page reload rechecks; Check again forces refresh and coalesces double click while pending', async () => {
  await start();
  expect(status()).toContain('No discussion found');
  updated(1, { status: 'complete' });
  await settle();
  expect(messages.filter((m) => m.type === 'get-finding')).toHaveLength(2);
  const wait = pending<Finding>();
  respond = () => wait.promise;
  refreshButton().click();
  await settle();
  refreshButton().click();
  await settle();
  expect(messages.at(-1).refresh).toBe(true);
  expect(messages.filter((m) => m.type === 'get-finding')).toHaveLength(3);
  wait.resolve(emptyFinding(active.url, 'none'));
  await settle();
  expect(refreshButton().disabled).toBe(false);
});
test('worker failure is retryable and cannot become an unsupported-page message', async () => {
  respond = async () => {
    throw new Error('worker asleep');
  };
  await start();
  expect(status()).toContain('Couldn’t check');
  expect(refreshButton().textContent).toBe('Retry');
  respond = async () => emptyFinding(active.url, 'none');
  refreshButton().click();
  await settle();
  expect(status()).toContain('No discussion found');
});
test('failed thread retries anonymously through worker; successful thread has explicit zero-comment state', async () => {
  let attempts = 0;
  respond = async (message) =>
    message.type === 'get-finding'
      ? found(active.url)
      : ++attempts === 1
        ? { ok: false, error: 'offline' }
        : { ok: true, html: noComments, prefetched: false };
  await start();
  expect(window.document.querySelector('.thread')!.textContent).toContain('Couldn’t load comments');
  const retry = window.document.querySelector<HappyButton>('.thread-controls button')!;
  expect(retry.textContent).toBe('Retry');
  retry.click();
  await waitFor(() => retry.textContent !== 'Retry');
  expect(attempts).toBe(2);
  expect(messages.at(-1).refresh).toBe(true);
  expect(window.document.querySelector('.thread')!.textContent).toContain('No comments yet');
  expect(status()).toContain('0 comments');
  expect(window.document.querySelector<HappyAnchor>('.thread-controls a')!.href).toBe(
    'https://news.ycombinator.com/item?id=999',
  );
});
test('refresh preserves existing thread on failure and same-results recheck preserves disclosure state', async () => {
  respond = async (message) =>
    message.type === 'get-finding' ? found(active.url) : { ok: true, html: withComments, prefetched: false };
  await start();
  const head = window.document.querySelector<HappyButton>('.head')!;
  head.click();
  expect(head.getAttribute('aria-expanded')).toBe('false');
  refreshButton().click();
  await settle();
  expect(window.document.querySelector('.head')).toBe(head);
  expect(head.getAttribute('aria-expanded')).toBe('false');
  respond = async () => emptyFinding(active.url, 'error', 'offline');
  refreshButton().click();
  await settle();
  expect(status()).toContain('Showing earlier results');
  expect(window.document.querySelector('.head')).toBe(head);
});
test('an unsupported page gives actionable guidance without a false negative', async () => {
  active = { id: 1, url: 'chrome://extensions/' };
  respond = async () => emptyFinding(active.url, 'unhashable');
  await start();
  expect(status()).toContain('HTTP or HTTPS');
});

test('same-tab navigation during a pending lookup supersedes the old URL', async () => {
  const old = pending<Finding>();
  respond = () => old.promise;
  await start();
  active = { id: 1, url: 'https://example.org/new' };
  respond = async () => emptyFinding(active.url, 'none');
  updated(1, { status: 'complete' });
  await settle();
  expect(status()).toContain('No discussion found');
  old.resolve(emptyFinding('https://example.org/a', 'error', 'STALE'));
  await settle();
  expect(status()).toContain('No discussion found');
  expect(window.document.querySelector('#detail')!.textContent).not.toBe('STALE');
});
test('retained thread callbacks still update totals after an unchanged finding refresh', async () => {
  let commentCount = 2;
  respond = async (message) =>
    message.type === 'get-finding'
      ? found(active.url)
      : { ok: true, html: noComments.replace('discuss', `${commentCount} comments`), prefetched: false };
  await start();
  refreshButton().click();
  await settle();
  commentCount = 7;
  window.document.querySelector<HappyButton>('.thread-controls button')!.click();
  await waitFor(() => status()!.includes('7 comments'));
  expect(status()).toContain('7 comments');
  refreshButton().click();
  await settle();
  expect(status()).toContain('7 comments');
});

test('same-page activation/completion cannot cancel a pending forced refresh or replace it with cached results', async () => {
  await start();
  const wait = pending<Finding>();
  respond = () => wait.promise;
  refreshButton().click();
  await settle();
  const before = messages.length;
  activated();
  updated(1, { status: 'complete' });
  await settle();
  expect(messages.length).toBe(before);
  expect(refreshButton().disabled).toBe(true);
  wait.resolve(emptyFinding(active.url, 'error', 'FRESH RESPONSE'));
  await settle();
  expect(window.document.querySelector('#detail')!.textContent).toBe('FRESH RESPONSE');
  expect(refreshButton().disabled).toBe(false);
  expect(status()).not.toBe('Checking this page…');
});

test('native disclosure buttons expose focus and state, and unrecognized HTML is retryable', async () => {
  let broken = true;
  respond = async (message) =>
    message.type === 'get-finding'
      ? found(active.url)
      : { ok: true, html: broken ? '<html>upstream error</html>' : noComments, prefetched: false };
  await start();
  const head = window.document.querySelector<HappyButton>('.head')!;
  head.focus();
  expect(window.document.activeElement).toBe(head);
  expect(head.tagName).toBe('BUTTON');
  expect(head.getAttribute('aria-expanded')).toBe('true');
  expect(head.getAttribute('aria-controls')).toBe('thread-999');
  head.click();
  expect(head.getAttribute('aria-expanded')).toBe('false');
  head.click();
  await settle();
  expect(window.document.querySelector('.thread')!.textContent).toContain('Couldn’t load comments');
  broken = false;
  window.document.querySelector<HappyButton>('.thread-controls button')!.click();
  await settle();
  expect(window.document.querySelector('.thread')!.textContent).toContain('No comments yet');
});

test('explicit refresh intent survives a delayed tab query overtaken by a same-page event', async () => {
  await start();
  const wait = pending<unknown>();
  let queries = 0;
  globalThis.chrome.tabs.query = (async () => (++queries === 1 ? wait.promise : [active])) as typeof chrome.tabs.query;
  const before = messages.length;
  refreshButton().click();
  await settle();
  activated();
  await settle();
  expect(messages.length).toBe(before + 1);
  expect(messages.at(-1).refresh).toBe(true);
  wait.resolve([active]);
  await settle();
  expect(messages.length).toBe(before + 1);
  expect(refreshButton().disabled).toBe(false);
});
