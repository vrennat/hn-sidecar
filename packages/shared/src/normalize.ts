/**
 * URL normalization — the algorithm the whole product stands on.
 *
 * Three consumers must agree byte-for-byte: the ingest Worker, the regen batch,
 * and the extension. A mismatch is silent (the badge simply never appears), so
 * the golden vectors in `vectors.ts` are the contract, not this prose.
 *
 * Posture: aggressive on *known* tracking params, conservative on unknown ones.
 * The client computes exactly one hash from the address bar; the corpus side
 * emits variants (see `urlVariants`). Recall therefore has to come mostly from
 * the canonical form, which is why known trackers are stripped rather than
 * preserved and matched by variant.
 */

/** Bumping this invalidates every published hash. */
export const NORM_VERSION = 1;

/** Subdomain labels that denote a mirror of the same document, not a different one. */
const MIRROR_PREFIXES = ['www', 'm', 'mobile', 'amp'];

/** Exact-host rewrites applied after prefix stripping, looped until stable. */
const HOST_ALIASES: Readonly<Record<string, string>> = {
  'x.com': 'twitter.com',
  'old.reddit.com': 'reddit.com',
  'new.reddit.com': 'reddit.com',
  'np.reddit.com': 'reddit.com',
  'i.reddit.com': 'reddit.com',
  'youtu.be': 'youtube.com',
};

/**
 * Params that never change which document you are looking at. Stripping them is
 * what makes an address-bar URL collide with the as-submitted-to-HN URL.
 * Anything not listed here is preserved (and sorted), because an unknown param
 * may well select the content.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid', 'gclid', 'dclid', 'gclsrc', 'gbraid', 'wbraid', 'msclkid', 'yclid',
  'mc_cid', 'mc_eid', 'igshid', 'igsh', 'si', 'spm', 'scmp', 'xtor',
  'ref', 'ref_src', 'ref_url', 'referrer', 'referer', 'source', 'src',
  'cmpid', 'campaign_id',
  '_hsenc', '_hsmi', 'hsctatracking', '_ga', '_gl', 'trk', 'trkcampaign',
  '__twitter_impression', 'guccounter', 'guce_referrer', 'guce_referrer_sig',
  'share', 'shared', 'sh', 'smid', 'smtyp', 'partner', 'sref', 'ncid',
  'cmp', 'at_medium', 'at_campaign', 'ito', 'ftag', 'taid',
]);

const TRACKING_PREFIXES = ['utm_', 'at_custom', 'pk_', 'piwik_', 'matomo_', 'hsa_'];

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

const INDEX_FILES = ['index.html', 'index.htm', 'index.php', 'default.aspx'];

const isTracking = (name: string): boolean =>
  TRACKING_PARAMS.has(name) ||
  TRACKING_PARAMS.has(name.toLowerCase()) ||
  TRACKING_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix));

/** Strip mirror subdomains, then apply exact aliases, until the host stops changing. */
const canonicalHost = (hostname: string): string => {
  let host = hostname.toLowerCase().replace(/\.+$/, '');
  for (let pass = 0; pass < 4; pass += 1) {
    const before = host;
    const labels = host.split('.');
    const head = labels[0];
    // Require 2+ remaining labels so "m.co" style hosts are not stripped to a TLD.
    if (head !== undefined && labels.length > 2 && MIRROR_PREFIXES.includes(head)) {
      host = labels.slice(1).join('.');
    }
    const alias = HOST_ALIASES[host];
    if (alias !== undefined) host = alias;
    if (host === before) break;
  }
  return host;
};

const canonicalPath = (rawPath: string): string => {
  let path = rawPath.replace(/\/{2,}/g, '/');

  const segments = path.split('/').filter((segment) => segment.length > 0);

  // AMP appears as a leading segment, a trailing segment, or a suffix.
  while (segments.length > 0 && segments[0] === 'amp') segments.shift();
  while (segments.length > 0 && segments[segments.length - 1] === 'amp') segments.pop();

  const last = segments[segments.length - 1];
  if (last !== undefined) {
    if (INDEX_FILES.includes(last.toLowerCase())) {
      segments.pop();
    } else if (last.toLowerCase().endsWith('.amp')) {
      segments[segments.length - 1] = last.slice(0, -'.amp'.length);
    }
  }

  path = segments.length > 0 ? `/${segments.join('/')}` : '';
  return path;
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** YouTube's four URL shapes for one video, folded into `youtube.com/watch?v=ID`. */
const foldYouTube = (host: string, path: string, params: URLSearchParams): { path: string } | null => {
  if (host !== 'youtube.com') return null;
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const head = segments[0];
  const tail = segments[1];

  if (head === 'watch') return { path: '/watch' };

  // youtu.be/ID has already been aliased to youtube.com/ID. Require the video-id
  // shape so /playlist, /@handle, and /feed are not folded into a bogus watch URL.
  if (segments.length === 1 && head !== undefined && VIDEO_ID.test(head)) {
    params.set('v', head);
    return { path: '/watch' };
  }
  if ((head === 'shorts' || head === 'embed' || head === 'live' || head === 'v') && tail !== undefined) {
    params.set('v', tail);
    return { path: '/watch' };
  }
  return null;
};

/**
 * Returns the canonical normalized form: `host[:port][/path][?sorted-query]`.
 * The scheme is dropped entirely so http and https collide, and the fragment is
 * dropped. Returns `null` for anything that is not an http(s) URL.
 */
export const normalizeUrl = (input: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = canonicalHost(parsed.hostname);
  if (host.length === 0) return null;

  const params = new URLSearchParams(parsed.search);
  let path = canonicalPath(parsed.pathname);

  const youtube = foldYouTube(host, path, params);
  if (youtube !== null) {
    path = youtube.path;
    const videoId = params.get('v');
    for (const name of [...params.keys()]) params.delete(name);
    if (videoId !== null) params.set('v', videoId);
  }

  for (const name of [...params.keys()]) {
    if (isTracking(name)) params.delete(name);
  }

  const pairs = [...params.entries()].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const sorted = new URLSearchParams();
  for (const [name, value] of pairs) sorted.append(name, value);
  const query = sorted.toString();

  const port = parsed.port !== '' && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : '';

  return `${host}${port}${path}${query.length > 0 ? `?${query}` : ''}`;
};

/**
 * Corpus-side only. Ingest emits one row per variant. The client must
 * never expand variants — doing so on both sides inflates a measured match rate
 * without improving the shipped one.
 *
 * **Currently the canonical form is the only variant, and that is deliberate.**
 *
 * v1 also emitted a query-stripped variant. Two pieces of evidence killed it:
 *
 * 1. The match-rate experiment measured its contribution at *exactly zero* (777/858
 *    with and without). Misses are sites rewriting their own paths, which no
 *    variant reaches.
 * 2. It is actively harmful where the query *is* the document's identity.
 *    Stripping the query from `youtube.com/watch?v=X` yields `youtube.com/watch`
 *    for every video on the site — 20,344 seeded stories published that single
 *    hash, producing one 2.8 MB shard (against a ~25 KB budget) and turning bare
 *    `youtube.com/watch` into a 20,000-way false positive.
 *
 * The function is kept as the extension point so that a variant with *measured*
 * benefit can be added without touching the ingest or regen paths.
 */
export const urlVariants = (input: string): string[] => {
  const canonical = normalizeUrl(input);
  if (canonical === null) return [];
  return [canonical];
};
