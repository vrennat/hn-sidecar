/**
 * Turns an HN item page into a flat comment list.
 *
 * The design bet: HN's item page has already done the expensive work. Rows arrive in
 * display order with their depth in an `indent` attribute, dead and deleted comments
 * are pruned server-side, and downweighting is expressed as a class. So the tree is
 * pre-flattened and we do **one** `DOMParser` pass over the whole document — no
 * per-comment string parsing. Verified on the 2,376-comment thread: 3.46 MB, all rows
 * in one response, max indent 13, no pagination link.
 *
 * Bodies stay as nodes in the inert parsed document. Nothing from the network reaches
 * the live DOM here; that is the sanitizer's job, done lazily per row.
 *
 * The dependency is named honestly in the plan: this HTML is unversioned. The failure
 * mode is loud — zero rows — which is why `parseThread` reports the count and the panel
 * degrades to a link rather than showing an empty thread.
 */

export interface ThreadRow {
  readonly id: number;
  /** HN's own `indent` value: 0 for a top-level comment, up to 13 observed. */
  readonly depth: number;
  readonly author: string | null;
  readonly ageText: string | null;
  /** Unix seconds, 0 when unparseable. */
  readonly ts: number;
  /** True for a downweighted comment: any `commtext` class other than `c00`. */
  readonly dim: boolean;
  /** The inert `.commtext` element from the parsed document. Never inserted directly. */
  readonly body: Element | null;
}

export interface Thread {
  readonly storyId: number;
  readonly title: string | null;
  readonly storyUrl: string | null;
  /**
   * The story's own score and comment count, read off the item page's subtext. These
   * are the page's authoritative values — unlike the index's `score`/`descendants`,
   * which are captured at ingest and can lag badly. `null` when the markup is absent,
   * so the caller can keep its existing value rather than trusting a failed parse.
   */
  readonly points: number | null;
  readonly comments: number | null;
  readonly rows: readonly ThreadRow[];
}

const parseAgeAttr = (title: string): { ts: number } => {
  const unix = / (\d{9,})$/.exec(title)?.[1];
  if (unix !== undefined) return { ts: Number.parseInt(unix, 10) };
  const iso = title.split(' ')[0];
  const parsed = iso === undefined ? Number.NaN : Date.parse(`${iso}Z`);
  return { ts: Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000) };
};

/** `"290 points"` / `"159 comments"` → number, `null` when the digits are absent. */
const parseCountOrNull = (text: string | null | undefined): number | null => {
  if (text === null || text === undefined) return null;
  const digits = /(\d+)/.exec(text)?.[1];
  return digits === undefined ? null : Number.parseInt(digits, 10);
};

export const parseThread = (html: string, storyId: number): Thread => {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const titleLink = doc.querySelector('.titleline > a');
  const rows: ThreadRow[] = [];

  for (const row of doc.querySelectorAll('tr.athing.comtr')) {
    const id = Number.parseInt(row.id, 10);
    if (!Number.isFinite(id)) continue;

    const indent = row.querySelector('td.ind')?.getAttribute('indent');
    const body = row.querySelector('.commtext');
    const ageEl = row.querySelector('span.age');
    const ageTitle = ageEl?.getAttribute('title') ?? '';

    // `c00` is a normal comment; c5A, c73, c88, c9C, cAE, cBE, cCE, cDD are HN's
    // downweighting shades. Case varies in the markup, so compare lowercased.
    const shade = [...(body?.classList ?? [])].find((name) => /^c[0-9a-f]{2}$/i.test(name));

    rows.push({
      id,
      depth: indent === null || indent === undefined ? 0 : Number.parseInt(indent, 10) || 0,
      author: row.querySelector('.hnuser')?.textContent?.trim() ?? null,
      ageText: ageEl?.textContent?.trim() ?? null,
      dim: shade !== undefined && shade.toLowerCase() !== 'c00',
      body,
      ...parseAgeAttr(ageTitle),
    });
  }

  const subtext = doc.querySelector('.subtext');
  const commentLink =
    subtext === null ? undefined : [...subtext.querySelectorAll('a')].find((a) => /\bcomments?\b|^\s*discuss\s*$/.test(a.textContent ?? ''));

  return {
    storyId,
    title: titleLink?.textContent?.trim() ?? null,
    storyUrl: titleLink?.getAttribute('href') ?? null,
    points: parseCountOrNull(subtext?.querySelector('.score')?.textContent),
    comments: commentLink?.textContent?.trim() === 'discuss' ? 0 : parseCountOrNull(commentLink?.textContent),
    rows,
  };
};

/**
 * How many rows are descendants of `index` — the reply count for a collapse toggle.
 *
 * Depth is right there in the flat list, so this is a walk forward until the depth
 * stops being greater than the row's own. No tree needs building.
 */
export const descendantCount = (rows: readonly ThreadRow[], index: number): number => {
  const own = rows[index]?.depth;
  if (own === undefined) return 0;
  let count = 0;
  for (let next = index + 1; next < rows.length; next += 1) {
    const depth = rows[next]?.depth;
    if (depth === undefined || depth <= own) break;
    count += 1;
  }
  return count;
};
