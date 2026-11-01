/**
 * Parses a real, unmodified HN item page.
 *
 * The fixture matters more than the assertions. The plan names the scrape dependency
 * honestly: item-page HTML is unversioned, and the mitigation is that a breakage is
 * loud rather than silent. These tests are that loudness, pinned to markup HN actually
 * served — a hand-written fixture would only ever assert what we already believe.
 *
 * The counts below come from the captured page: 159 comment rows, indents 0..7,
 * 13 downweighted comments across c5A/c73/c88/c9C.
 */

import { describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { descendantCount, parseThread } from './thread.ts';

const STORY_ID = 49103285;
const fixture = await Bun.file(new URL('./fixtures/item-49103285.html', import.meta.url)).text();

// happy-dom supplies the DOM this module expects; in production it is the panel's own.
const window = new Window();
const globals = globalThis as unknown as { DOMParser: unknown; Node: unknown };
globals.DOMParser = window.DOMParser;
globals.Node = window.Node;

const thread = parseThread(fixture, STORY_ID);

describe('parseThread', () => {
  describe('happy path', () => {
    it('finds every comment row', () => {
      expect(thread.rows.length).toBe(159);
    });

    it('reads the story title', () => {
      expect(thread.title).not.toBeNull();
      expect(thread.title?.length).toBeGreaterThan(0);
    });

    it('keeps rows in the page order HN served', () => {
      // The first row must be top level: HN emits display order, so a non-zero first
      // depth would mean the flattening assumption is wrong.
      expect(thread.rows[0]?.depth).toBe(0);
    });

    it('reads depth from the indent attribute', () => {
      const depths = new Set(thread.rows.map((row) => row.depth));
      expect(Math.max(...depths)).toBe(7);
      expect(depths.has(0)).toBe(true);
    });

    it('attributes every row to an author', () => {
      expect(thread.rows.filter((row) => row.author === null)).toHaveLength(0);
    });

    it('gives every row a body', () => {
      expect(thread.rows.filter((row) => row.body === null)).toHaveLength(0);
    });

    it('resolves timestamps from the age title attribute', () => {
      expect(thread.rows.filter((row) => row.ts === 0)).toHaveLength(0);
    });

    it('reads the story score and comment count off the subtext', () => {
      // Pinned to the captured page: "290 points", "159 comments".
      expect(thread.points).toBe(290);
      expect(thread.comments).toBe(159);
    });
  });

  describe('downweighted comments', () => {
    it('marks the shaded ones dim and leaves c00 alone', () => {
      expect(thread.rows.filter((row) => row.dim)).toHaveLength(13);
    });
  });

  describe('error cases', () => {
    it('yields zero rows for markup it does not recognise, rather than throwing', () => {
      // The loud failure the fallback ladder depends on.
      expect(parseThread('<html><body><p>nope</p></body></html>', 1).rows).toHaveLength(0);
    });

    it('yields zero rows for an empty document', () => {
      expect(parseThread('', 1).rows).toHaveLength(0);
    });
  });
});

describe('descendantCount', () => {
  it('counts the whole subtree, not just direct replies', () => {
    const rows = [{ depth: 0 }, { depth: 1 }, { depth: 2 }, { depth: 1 }, { depth: 0 }] as never;
    expect(descendantCount(rows, 0)).toBe(3);
  });

  it('returns 0 for a leaf', () => {
    const rows = [{ depth: 0 }, { depth: 0 }] as never;
    expect(descendantCount(rows, 0)).toBe(0);
  });

  it('returns 0 past the end', () => {
    const rows = [{ depth: 0 }] as never;
    expect(descendantCount(rows, 5)).toBe(0);
  });

  it('agrees with the real thread: every row plus its descendants covers the list once', () => {
    // Sum of top-level subtree sizes must be the whole thread.
    const topLevel = thread.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.depth === 0);
    const covered = topLevel.reduce((sum, { index }) => sum + 1 + descendantCount(thread.rows, index), 0);
    expect(covered).toBe(thread.rows.length);
  });
});

describe('empty discussion', () => {
  it('recognizes HN’s discuss link as zero comments without treating malformed pages as empty', () => {
    const html = '<table><tr><td class="titleline"><a>Story</a></td></tr><tr><td class="subtext"><a href="item?id=123">discuss</a></td></tr></table>';
    expect(parseThread(html, 123).comments).toBe(0);
    expect(parseThread('<html>unexpected response</html>', 123).comments).toBeNull();
  });
});
