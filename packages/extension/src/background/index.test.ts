import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { hashUrl } from '@hn-sidecar/shared';
import type { Finding, Request as Message } from '../lib/protocol.ts';
let serial = 0;
let receive: (message: Message, sender: unknown, reply: (value: unknown) => void) => boolean;
let updated: (id: number, info: { status: string }, tab: { url: string }) => void;
let removed: (id: number) => void;
let saved: { chrome: typeof chrome; fetch: typeof fetch };
let stored: Record<string, any>;
let now: number;
let clock: ReturnType<typeof spyOn>;
let tabs: Map<number, string>;
let badgeTitles: Map<number, string>;
const noop = { addListener() {} };
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
const request = (message: Message): Promise<Finding> =>
  new Promise((resolve) => {
    receive(message, {}, (value) => resolve(value as Finding));
  });
beforeEach(async () => {
  saved = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  stored = {};
  tabs = new Map();
  badgeTitles = new Map();
  now = Date.now() + ++serial * 10 * 3600_000;
  clock = spyOn(Date, 'now').mockImplementation(() => now);
  globalThis.chrome = {
    runtime: {
      onInstalled: noop,
      onStartup: noop,
      onMessage: {
        addListener(fn: typeof receive) {
          receive = fn;
        },
      },
    },
    sidePanel: { async setPanelBehavior() {} },
    storage: {
      session: {
        async get() {
          return structuredClone(stored);
        },
        async set(values: any) {
          Object.assign(stored, values);
        },
        async remove(keys: string | string[]) {
          for (const key of [keys].flat()) delete stored[key];
        },
      },
    },
    tabs: {
      async get(id: number) {
        return { id, url: tabs.get(id) };
      },
      onUpdated: {
        addListener(fn: typeof updated) {
          updated = fn;
        },
      },
      onRemoved: {
        addListener(fn: typeof removed) {
          removed = fn;
        },
      },
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle({ tabId, title }: { tabId: number; title: string }) {
        badgeTitles.set(tabId, title);
      },
    },
  } as unknown as typeof chrome;
  await import(`./index.ts?test=${serial}`);
});
afterEach(async () => {
  await settle();
  clock.mockRestore();
  Object.assign(globalThis, saved);
});
test('explicit refresh bypasses negative finding and local artifacts, with short negative/error TTLs', async () => {
  const id = 10001;
  const url = 'https://example.org/refresh';
  tabs.set(id, url);
  const hash = (await hashUrl(url))!;
  let populated = false,
    fail = false;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push(init!);
    const path = new URL(String(input)).pathname;
    if (fail) return new Response('offline', { status: 503 });
    if (path === '/manifest.json') return Response.json({ av: 1, nv: 1 });
    if (path === '/recent.json')
      return Response.json({
        av: 1,
        nv: 1,
        entries: populated ? [{ id: 123, h: hash.h, t: 'New', p: 1, c: 4, ts: 1793550000 }] : [],
      });
    return Response.json({ av: 1, nv: 1, b: hash.shard, e: [] });
  }) as typeof fetch;
  expect((await request({ type: 'get-finding', tabId: id, refresh: true })).source).toBe('none');
  expect(stored[`finding:${id}`].expiresAt - now).toBe(60_000);
  populated = true;
  expect((await request({ type: 'get-finding', tabId: id })).source).toBe('none');
  expect(calls).toHaveLength(3);
  expect((await request({ type: 'get-finding', tabId: id, refresh: true })).source).toBe('index');
  expect(calls.slice(-3).every((init) => init.cache === 'reload' && init.credentials === 'omit')).toBe(true);
  fail = true;
  expect((await request({ type: 'get-finding', tabId: id, refresh: true })).source).toBe('error');
  expect(stored[`finding:${id}`].expiresAt - now).toBe(15_000);
  fail = false;
  now += 15_001;
  expect((await request({ type: 'get-finding', tabId: id, refresh: true })).source).toBe('index');
});
test('late navigation cannot replace current finding/badge and tab deletion clears memory too', async () => {
  const id = 10002;
  const a = 'https://example.org/a';
  const b = 'https://example.org/b';
  const ha = (await hashUrl(a))!,
    hb = (await hashUrl(b))!;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith(`${ha.shard}.json`))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    if (path === '/manifest.json') return Response.json({ av: 1, nv: 1 });
    if (path === '/recent.json') return Response.json({ av: 1, nv: 1, entries: [] });
    return Response.json({ av: 1, nv: 1, b: hb.shard, e: [] });
  }) as typeof fetch;
  tabs.set(id, a);
  const first = request({ type: 'get-finding', tabId: id });
  await settle();
  tabs.set(id, b);
  updated(id, { status: 'complete' }, { url: b });
  await settle();
  expect(stored[`finding:${id}`].value.url).toBe(b);
  finish(Response.json({ av: 1, nv: 1, b: ha.shard, e: [] }));
  await first;
  await settle();
  expect((await request({ type: 'get-finding', tabId: id })).url).toBe(b);
  expect(badgeTitles.get(id)).toContain('no discussion');
  removed(id);
  await settle();
  expect(stored[`finding:${id}`]).toBeUndefined();
});
