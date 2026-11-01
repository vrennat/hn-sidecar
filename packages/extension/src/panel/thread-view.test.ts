import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderThread } from './thread-view.ts';
test('thread view exposes comment permalinks/disclosures and disconnects lazy rendering on disposal', () => {
  const window = new Window();
  const saved = {
    document: globalThis.document,
    Node: globalThis.Node,
    IntersectionObserver: globalThis.IntersectionObserver,
  };
  let disconnects = 0;
  let callback!: (entries: { isIntersecting: boolean; target: unknown }[]) => void;
  Object.assign(globalThis, {
    document: window.document,
    Node: window.Node,
    IntersectionObserver: class {
      constructor(fn: typeof callback) {
        callback = fn;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        disconnects++;
      }
    },
  });
  try {
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const body = window.document.createElement('div');
    body.textContent = 'Comment';
    const dispose = renderThread(
      {
        storyId: 1,
        title: 'Story',
        storyUrl: null,
        points: 1,
        comments: 2,
        rows: [
          { id: 11, depth: 0, author: 'alice', ageText: null, ts: 1, dim: false, body: body as unknown as Element },
          { id: 12, depth: 1, author: 'bob', ageText: null, ts: 1, dim: false, body: null },
        ],
      },
      host as unknown as HTMLElement,
    );
    expect(host.querySelector('a')?.href).toBe('https://news.ycombinator.com/item?id=11');
    const toggle = host.querySelector('button')!;
    toggle.focus();
    expect(window.document.activeElement).toBe(toggle);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelectorAll('.row')[1]?.hasAttribute('hidden')).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-label')).toBe('Collapse comment by alice');
    callback([{ isIntersecting: true, target: host.querySelector('.row')! }]);
    expect(host.querySelector('.body')?.textContent).toBe('Comment');
    dispose();
    expect(disconnects).toBe(1);
  } finally {
    Object.assign(globalThis, saved);
    window.close();
  }
});
