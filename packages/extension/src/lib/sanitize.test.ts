import { describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { sanitizeBody } from './sanitize.ts';
import { parseThread } from './thread.ts';

const fixture = await Bun.file(new URL('./fixtures/item-49103285.html', import.meta.url)).text();

const window = new Window();
const globals = globalThis as unknown as { DOMParser: unknown; Node: unknown };
globals.DOMParser = window.DOMParser;
globals.Node = window.Node;

const doc = window.document as unknown as Document;

/** Parses untrusted markup the way the panel receives it: as an inert document. */
const inert = (html: string): Element => {
  const parsed = new window.DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = parsed.querySelector('#root');
  if (root === null) throw new Error('fixture markup did not parse');
  return root as unknown as Element;
};

const render = (html: string): string => {
  const host = doc.createElement('div');
  host.append(sanitizeBody(inert(html), doc));
  return host.innerHTML;
};

describe('sanitizeBody', () => {
  describe('allowlist', () => {
    it('keeps the tags HN actually emits', () => {
      expect(render('<p>one</p><i>two</i><pre><code>three</code></pre>')).toBe(
        '<p>one</p><i>two</i><pre><code>three</code></pre>',
      );
    });

    it('keeps a safe link and forces its rel', () => {
      const html = render('<a href="https://example.com/x" rel="">link</a>');
      expect(html).toContain('href="https://example.com/x"');
      expect(html).toContain('rel="noopener noreferrer nofollow"');
    });

    it('does not trust the source rel, it replaces it', () => {
      expect(render('<a href="https://example.com" rel="opener">x</a>')).not.toContain('rel="opener"');
    });
  });

  describe('what must not survive', () => {
    it('drops a script element entirely, including its text', () => {
      // Unwrapping keeps text, so the text of a script must not reach the output.
      expect(render('<p>before</p><script>alert(1)</script>')).toBe('<p>before</p>');
    });

    it('drops a javascript: href but keeps the link text', () => {
      const html = render('<a href="javascript:alert(1)">click</a>');
      expect(html).not.toContain('javascript:');
      expect(html).toContain('click');
    });

    it('drops a data: href', () => {
      expect(render('<a href="data:text/html,<b>x</b>">click</a>')).not.toContain('data:');
    });

    it('drops event handler attributes', () => {
      const html = render('<p onclick="alert(1)">text</p>');
      expect(html).toBe('<p>text</p>');
    });

    it('drops an img, which cannot appear in a comment and would be a network request', () => {
      expect(render('<p>a</p><img src="https://tracker.example/x.gif">')).toBe('<p>a</p>');
    });

    it('unwraps an unexpected element rather than losing the text inside it', () => {
      // If HN adds a wrapper, a comment must degrade to plain text, never to blank.
      expect(render('<span>kept</span>')).toBe('kept');
      expect(render('<section><p>nested</p></section>')).toBe('<p>nested</p>');
    });
  });

  describe('against the real fixture', () => {
    it('produces non-empty output for every comment body', () => {
      const rows = parseThread(fixture, 49103285).rows;
      const empty = rows.filter((row) => {
        if (row.body === null) return true;
        const host = doc.createElement('div');
        host.append(sanitizeBody(row.body, doc));
        return host.textContent === null || host.textContent.trim().length === 0;
      });
      expect(empty).toHaveLength(0);
    });

    it('never emits a tag outside the allowlist', () => {
      const rows = parseThread(fixture, 49103285).rows;
      const seen = new Set<string>();
      for (const row of rows) {
        if (row.body === null) continue;
        const host = doc.createElement('div');
        host.append(sanitizeBody(row.body, doc));
        for (const element of host.querySelectorAll('*')) seen.add(element.tagName);
      }
      // A subset, not an equality: which of the five tags a given thread happens to use
      // is a property of the thread. This fixture has no code blocks.
      const allowed = new Set(['A', 'CODE', 'I', 'P', 'PRE']);
      expect([...seen].filter((tag) => !allowed.has(tag))).toEqual([]);
      expect(seen.size).toBeGreaterThan(0);
    });
  });
});

describe('resolved comment links', () => {
  it('uses HN for relative and root-relative links, and HTTPS for protocol-relative links', () => {
    expect(render('<a href="item?id=123">discussion</a>')).toContain('href="https://news.ycombinator.com/item?id=123"');
    expect(render('<a href="/user?id=alice">author</a>')).toContain('href="https://news.ycombinator.com/user?id=alice"');
    expect(render('<a href="//example.com/path">site</a>')).toContain('href="https://example.com/path"');
  });
  it('does not turn missing/blank hrefs into links to the extension or HN homepage', () => {
    expect(render('<a>label</a><a href="  ">blank</a>')).not.toContain('href=');
  });
});
