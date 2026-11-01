import { expect, test } from 'bun:test';
import { applyBadge } from './badge.ts';
import { emptyFinding } from '../lib/protocol.ts';
test('delayed badge writes finish in navigation order and a closed-tab failure does not poison the queue', async () => {
  const original = globalThis.chrome;
  let release!: () => void;
  const state = { text: '', title: '' };
  globalThis.chrome = {
    action: {
      async setBadgeText({ text }: { text: string }) {
        if (text === '1')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        state.text = text;
      },
      async setBadgeBackgroundColor() {},
      async setTitle({ title }: { title: string }) {
        state.title = title;
      },
    },
  } as unknown as typeof chrome;
  const finding = (comments: number) => ({
    ...emptyFinding('https://example.org', 'index'),
    totalComments: comments,
    submissions: [{ id: 1, title: 'Story', comments, points: 1, ts: 1 }],
  });
  try {
    let current = true;
    const old = applyBadge(1, finding(1), () => current);
    await Promise.resolve();
    current = false;
    const next = applyBadge(1, finding(2));
    release();
    await old;
    await next;
    expect(state.text).toBe('2');
    expect(state.title).toContain('2 comments');
    globalThis.chrome.action.setBadgeText = async () => {
      throw new Error('closed');
    };
    await applyBadge(1, null);
    globalThis.chrome.action.setBadgeText = async ({ text }) => {
      state.text = text ?? '';
    };
    await applyBadge(1, finding(3));
    expect(state.text).toBe('3');
    expect(state.title).toContain('3 comments');
  } finally {
    globalThis.chrome = original;
  }
});
