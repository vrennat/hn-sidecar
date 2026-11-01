import { afterEach, beforeEach, expect, test } from 'bun:test';
import { hashUrl } from '@hn-sidecar/shared';
import { lookupUrl } from './lookup.ts';

const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;
beforeEach(() => {
  // Each case explicitly revalidates fixtures; shared caches may be warm from another suite.
  globalThis.chrome = { storage: { session: {
    async get() { return {}; }, async set() {}, async remove() {},
  } } } as unknown as typeof chrome;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.chrome = originalChrome;
});

const url = 'https://example.org/new-discussion';
const hash = (await hashUrl(url))!;
const entry = { h: hash.h, id: 123, t: 'New discussion', p: 10, c: 4, ts: 1793550000 };
const serve = (recent: () => Response, manifest = { av: 1, nv: 1 }) => {
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/manifest.json') return Response.json(manifest);
    if (path === '/recent.json') return recent();
    return Response.json({ av: 1, nv: 1, b: hash.shard, e: [] });
  }) as typeof fetch;
};

test('new discussion matches through recent index while its shard is still cached empty', async () => {
  serve(() => Response.json({ av: 1, nv: 1, entries: [entry] }));
  const finding = await lookupUrl(url, true);
  expect(finding.source).toBe('index');
  expect(finding.submissions.map((s) => s.id)).toEqual([123]);
  expect(finding.totalComments).toBe(4);
});

test('recent-index outage is a lookup error rather than a false no-discussion result', async () => {
  serve(() => new Response('unavailable', { status: 503 }));
  const finding = await lookupUrl(url, true);
  expect(finding.source).toBe('error');
  expect(finding.detail).toContain('recent.json');
});

test('incompatible recent index asks for an update', async () => {
  serve(() => Response.json({ av: 1, nv: 2, entries: [] }));
  expect((await lookupUrl(url, true)).source).toBe('version-skew');
});

test('incompatible manifest artifact version asks for an update', async () => {
  serve(() => Response.json({ av: 1, nv: 1, entries: [] }), { av: 2, nv: 1 });
  expect((await lookupUrl(url, true)).source).toBe('version-skew');
});

test('successful compatible empty artifacts still report no discussion', async () => {
  serve(() => Response.json({ av: 1, nv: 1, entries: [] }));
  expect((await lookupUrl(url, true)).source).toBe('none');
});
