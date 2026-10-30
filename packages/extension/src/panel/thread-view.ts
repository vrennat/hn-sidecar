/**
 * Renders a flat comment list with collapse/expand and lazy sanitization.
 *
 * Row shells are created for every comment up front — 2,376 `div`s is nothing — but a
 * body is only sanitized and inserted when its row enters the viewport. That is what
 * makes the biggest thread on HN open instantly: the expensive per-comment work is
 * proportional to what the user actually looks at, not to the thread's size.
 *
 * Virtualization would replace the row shells too. It is deliberately not
 * here: it matters for ~1% of threads and this is the version that has to be usable
 * daily first.
 */

import { sanitizeBody } from '../lib/sanitize.ts';
import { descendantCount, type Thread, type ThreadRow } from '../lib/thread.ts';

const MAX_INDENT_PX = 22;

const relativeAge = (ts: number, fallback: string | null): string => {
  if (ts === 0) return fallback ?? '';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  const units: readonly (readonly [number, string])[] = [
    [31_536_000, 'y'],
    [2_592_000, 'mo'],
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
  ];
  for (const [size, label] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
  }
  return 'just now';
};

export const renderThread = (thread: Thread, host: HTMLElement): void => {
  host.textContent = '';

  if (thread.rows.length === 0) {
    // The loud failure mode the plan relies on: zero rows means the parse found
    // nothing, so say so and hand over a link rather than showing an empty thread.
    const empty = document.createElement('p');
    empty.className = 'notice';
    empty.textContent = 'No comments could be read from this thread.';
    host.append(empty, hnLink(thread.storyId, 'Open it on HN'));
    return;
  }

  const collapsed = new Set<number>();
  const elements: HTMLElement[] = [];
  const sanitized = new Set<number>();

  const observer = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        const element = record.target as HTMLElement;
        const index = Number.parseInt(element.dataset['index'] ?? '', 10);
        const row = thread.rows[index];
        if (row === undefined || sanitized.has(index)) {
          observer.unobserve(element);
          continue;
        }
        sanitized.add(index);
        const body = element.querySelector('.body');
        if (body !== null && row.body !== null) body.append(sanitizeBody(row.body, document));
        observer.unobserve(element);
      }
    },
    { root: host.closest('.scroller') ?? null, rootMargin: '600px 0px' },
  );

  const applyVisibility = (): void => {
    let hideBelowDepth = -1;
    thread.rows.forEach((row, index) => {
      const element = elements[index];
      if (element === undefined) return;
      if (hideBelowDepth >= 0 && row.depth > hideBelowDepth) {
        element.hidden = true;
        return;
      }
      hideBelowDepth = -1;
      element.hidden = false;
      if (collapsed.has(index)) hideBelowDepth = row.depth;
    });
  };

  const fragment = document.createDocumentFragment();
  thread.rows.forEach((row, index) => {
    const element = buildRow(row, index, thread.rows, collapsed, applyVisibility);
    elements.push(element);
    fragment.append(element);
    observer.observe(element);
  });
  host.append(fragment);
  applyVisibility();
};

const buildRow = (
  row: ThreadRow,
  index: number,
  rows: readonly ThreadRow[],
  collapsed: Set<number>,
  applyVisibility: () => void,
): HTMLElement => {
  const element = document.createElement('div');
  element.className = row.dim ? 'row dim' : 'row';
  element.dataset['index'] = String(index);
  // Leave room for text even in Chrome's narrow side panel.
  element.style.marginLeft = `min(${Math.min(row.depth, 13) * MAX_INDENT_PX}px, 28%)`;

  const replies = descendantCount(rows, index);

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.type = 'button';
  toggle.textContent = '–';
  toggle.title = replies === 0 ? 'Collapse' : `Collapse ${replies} ${replies === 1 ? 'reply' : 'replies'}`;
  toggle.setAttribute('aria-label', `Collapse comment by ${row.author ?? 'unknown'}`);
  toggle.setAttribute('aria-expanded', 'true');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = row.author ?? 'unknown';
  const age = document.createElement('span');
  age.className = 'age';
  age.textContent = relativeAge(row.ts, row.ageText);
  const count = document.createElement('span');
  count.className = 'replies';
  meta.append(toggle, author, age, count);

  const body = document.createElement('div');
  body.className = 'body';

  toggle.addEventListener('click', () => {
    const isCollapsed = collapsed.has(index);
    if (isCollapsed) collapsed.delete(index);
    else collapsed.add(index);
    element.classList.toggle('collapsed', !isCollapsed);
    toggle.textContent = isCollapsed ? '–' : '+';
    toggle.setAttribute('aria-expanded', String(isCollapsed));
    toggle.setAttribute('aria-label', `${isCollapsed ? 'Collapse' : 'Expand'} comment by ${row.author ?? 'unknown'}`);
    count.textContent = !isCollapsed && replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : '';
    applyVisibility();
  });

  element.append(meta, body);
  return element;
};

export const hnLink = (id: number, text: string): HTMLAnchorElement => {
  const link = document.createElement('a');
  link.href = `https://news.ycombinator.com/item?id=${id}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  return link;
};
