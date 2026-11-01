import { afterEach, expect, test } from 'bun:test';
import { prefetchThread, takeThread } from './thread-source.ts';
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test('opening during prefetch shares one anonymous GET; refresh bypasses retained HTML', async () => {
  let finish!: (response: Response) => void;
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(init!);
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as unknown as typeof fetch;
  const warming = prefetchThread(987);
  const opening = takeThread(987);
  expect(requests).toHaveLength(1);
  finish(new Response('thread'));
  await warming;
  expect((await opening).html).toBe('thread');
  const refresh = takeThread(987, true);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.cache).toBe('reload');
  expect(requests[1]?.credentials).toBe('omit');
  finish(new Response('new'));
  expect((await refresh).html).toBe('new');
});
test('failed requests leave no rejected promise in the in-flight map', async () => {
  let calls = 0;
  globalThis.fetch = (async () =>
    ++calls === 1 ? new Response('bad', { status: 503 }) : new Response('retry')) as unknown as typeof fetch;
  await expect(takeThread(988)).rejects.toThrow('503');
  expect((await takeThread(988)).html).toBe('retry');
  expect(calls).toBe(2);
});

test('late prefetch cannot repopulate stale HTML after a forced refresh', async () => {
  const finishes: ((response: Response) => void)[] = [];
  globalThis.fetch = (async () =>
    new Promise<Response>((resolve) => finishes.push(resolve))) as unknown as typeof fetch;
  const warming = prefetchThread(989);
  const refresh = takeThread(989, true);
  finishes[1]!(new Response('fresh'));
  expect((await refresh).html).toBe('fresh');
  finishes[0]!(new Response('old'));
  await warming;
  const next = takeThread(989);
  expect(finishes).toHaveLength(3);
  finishes[2]!(new Response('current'));
  expect((await next).html).toBe('current');
});
