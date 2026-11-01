# Architecture

HN Sidecar has one purpose: identify Hacker News discussions for pages the user browses and render those discussions in Chrome's side panel.

The design separates the user-facing read path from index construction. Browser lookups read static files from Cloudflare R2; only scheduled and authenticated administrative work reaches the Worker and D1.

## Design principles

1. **Do URL matching locally.** The exact page URL is never sent to the HN Sidecar index.
2. **Keep the read path static.** Browser traffic fetches CDN artifacts, not an application API.
3. **Request the minimum origins and Chrome permissions needed.** The extension touches only Hacker News and the static index origin.
4. **Treat remote HTML as untrusted.** HN comments are parsed and rebuilt through an allowlist before rendering.
5. **Prefer detectable staleness to silent incompatibility.** Artifacts carry schema and normalization versions.
6. **Publish complete states.** Shards are written before the manifest that describes them.

## System map

```text
Hacker News Firebase API
          │
          ▼
Cloudflare Worker cron ──► D1 (raw story authority)
          │                    │
          │                    ▼
          └──────────────► R2 static artifacts
                               │
                               ▼
                         Cloudflare CDN
                               │
                               ▼
                        Chrome extension
                               │
                               ├── toolbar badge
                               └── side-panel thread reader
```

The repository is organized as:

```text
packages/extension/       Chrome MV3 extension
packages/shared/          URL normalization, hashing, artifact contracts
db/schema.sql             D1 schema
workers/index-writer/     scheduled ingest and administrative regeneration
tools/seed/               historical seed creation and D1 import
tools/publish/            full regeneration and production verification
tools/match-rate/         normalization match-rate experiments
tools/d1-bench/           D1 import experiments
tools/toolkit/            shared CLI argument parsing
```


## Extension read path

### Navigation

The background service worker listens for completed HTTP(S) tab navigations. Each tab gets an independent finding and badge. Sequence guards prevent a slow lookup for a previous page from overwriting a newer navigation's result. Badge writes are serialized per tab because Chrome exposes count, color, and title as three separate asynchronous operations. The panel separately guards tab queries and lookup results; a same-page no-op cannot cancel an explicit refresh.

There are two discovery paths.

### HN link map

On `news.ycombinator.com`, a content script reads public listing rows already present in the page. It stores each story's normalized URL, ID, title, points, comment count, and timestamp in `chrome.storage.session`.

If the user follows one of those links, the destination can be badged from this session-local map without an index request. Redirects or normalization differences simply fall through to the static index lookup.

### Static index lookup

For an arbitrary HTTP(S) page, the extension:

1. Normalizes the URL.
2. Hashes `NORM_VERSION|normalized-url` with SHA-256.
3. Uses the digest's high 14 bits to select one of 16,384 shards.
4. Fetches `manifest.json`, `recent.json`, and `b/{0000..3fff}.json` from the static index.
5. Compares the digest's first 128 bits with candidate entries locally.
6. Merges and deduplicates matching submissions by HN story ID.

Only the shard name derived from 14 hash bits is URL-specific on the wire. The CDN also receives ordinary HTTPS metadata such as the IP address, user agent, timestamp, and requested path. It does not receive the exact URL, full SHA-256 digest, or whether the local comparison matched.

## Static artifacts

All artifacts include an artifact version (`av`) and normalization version (`nv`). A version mismatch is shown as an update-required state rather than a confident negative result.

### Shards

`b/{shard}.json` contains entries shaped conceptually as:

```text
128-bit digest, story id, title, points, comment count, timestamp
```

Titles remain inline. Fetching a title only after a local match would reveal the exact matching story ID to the server and defeat the prefix design.

Every shard is published, including empty shards. That keeps the client contract uniformly `200` and avoids making a `404` reveal that a bucket is empty.

### Recent index

`recent.json` carries stories from the last 48 hours. Clients always read it alongside the selected shard because a browser or CDN may still hold a six-hour-old shard when a new story arrives.

### Manifest

`manifest.json` records artifact versions, generation time, entry count, and shard count. It is written after the artifacts it describes, so a client can observe an older complete index but not a new manifest pointing at shards that were never published.

## Thread loading and rendering

The extension fetches public HN item pages with `credentials: 'omit'`; the user's HN login cookie is not sent.

The MV3 service worker performs the fetch because it owns cross-origin access and can retain a short-lived prefetch. The side panel performs parsing because service workers do not provide `DOMParser`.

The parser turns HN's flat comment rows and indentation levels into a flat typed representation. Rendering preserves that order and calculates descendant ranges for collapse behavior.

Comment bodies are never inserted with `innerHTML`. The sanitizer rebuilds text and a small allowlist of HN elements, validates link protocols, replaces link relationships, and drops executable or embedding elements entirely.

Thread HTML is cached in IndexedDB with an approximately 40 MB body cap, estimated conservatively as UTF-16 string bytes. Stories younger than 24 hours **when fetched** use a 10-minute TTL; older stories use 30 days. Expiry is fixed at fetch time, including for legacy records, so a story crossing 24 hours cannot extend an existing cache entry. Explicit Refresh comments bypasses the cache for active old discussions.

IndexedDB v2 separates small eviction metadata from HTML bodies. Pruning reads metadata only; HTML and metadata update in one transaction. Connections close after every operation. A blocked upgrade or storage/quota failure is a cache miss and permits the anonymous network path. Version-1 records migrate locally. Detached thread views disconnect their IntersectionObservers.

Public thread prefetches and opens share in-flight requests. A forced refresh supersedes an ordinary request; a late prefetch cannot repopulate old retained HTML. Known HTTP failures are surfaced for retry rather than automatically issuing a second identical request from the panel. A direct anonymous fetch remains a fallback only when the worker cannot answer.

## Index write path

### Historical seed

The seed tools produce resumable NDJSON, normalize and hash story URLs, import stories plus digest rows into D1, and initialize the ingest watermark. D1 retains raw URLs because a normalization-version change requires recomputing every digest.

The public extension does not need a local seed or Cloudflare account; it uses the hosted index by default.

### Scheduled ingest

The Worker runs every 10 minutes. It:

1. Reads HN's current `maxitem` and the stored watermark.
2. Fetches new item IDs plus the small `/updates.json` set, and up to 100 IDs
   each from `/newstories.json` and `/topstories.json`. These public feeds keep
   current discussions discoverable during historical catch-up and refresh active
   stories' engagement. IDs are deduplicated across all sources and rolling refresh.
3. Upserts URL-bearing stories into D1.
4. Replaces each changed story's digest rows.
5. Rewrites both newly touched and previously occupied shards.
6. Publishes the 48-hour recent index.
7. Writes the manifest last.
8. Advances the watermark.

Only the contiguous historical range advances the watermark; live-feed IDs never
skip the backlog. Upstream HTTP/parse failures abort before database or artifact
writes, leaving the cursor in place for the next tick. The feed caps bound work;
they do not guarantee exhaustive coverage through a prolonged ingestion outage.

Replacing old digest rows and rewriting previous buckets is necessary because moderators can retarget a story URL. Otherwise the old URL would continue matching indefinitely.

### Rolling metadata refresh

HN does not provide a complete “stories changed since” feed. Scores and comment counts captured near submission time would otherwise remain stale.

Each ingest tick therefore re-fetches 200 stories ordered by `refreshed_at`, then creation time:

- changed score, descendants, title, or URL: run through the normal upsert and shard rewrite path;
- confirmed dead or unchanged: advance `refreshed_at` with a cheap D1 update;
- transient fetch failure: leave the row stale so the next tick retries it.

At 200 stories per ten-minute tick, roughly 600,000 rows rotate in about three weeks. When the user opens a thread, the panel immediately corrects displayed points and comments from the freshly fetched HN item page.

### Full regeneration

Normalization or artifact changes require rebuilding all 16,384 shards. The authenticated administrative endpoint processes disjoint bucket ranges; the local publish driver runs ranges concurrently, finalizes the manifest only after all ranges succeed, and runs one ingest afterward to repair stories arriving during regeneration.

The administrative Worker uses a constant-time Bearer-token comparison. `ADMIN_TOKEN` is a Cloudflare secret and is never committed.

## Caching

Intended origin metadata:

| Artifact | Cache-Control |
|---|---|
| `manifest.json` | `public, max-age=300` |
| `recent.json` | `public, max-age=300` |
| Shards | `public, max-age=21600` |

The Cloudflare custom-domain Cache Rule must mark the hostname eligible for caching while respecting existing origin headers for both Edge TTL and Browser TTL. Overriding volatile artifacts to a multi-hour browser TTL prevents `recent.json` from covering newly submitted stories.

Inside the extension, session caches use these TTLs:

| Local cache | TTL |
|---|---|
| Manifest / recent index | 5 minutes |
| Shard | 1 hour |
| Matching finding / HN link map | 30 minutes |
| No-match finding | 1 minute |
| Failed finding | 15 seconds |

The worker hydrates session storage once per lifetime and serializes cache mutations. Eviction includes records from previous worker lifetimes: at most 400 link-map entries, 64 findings, and 96 artifact entries. Expired and closed-tab records are removed from memory and session storage. Storage failure falls back to bounded memory.

Check again bypasses the finding/link-map and local artifact caches, using Fetch `cache: reload` with credentials omitted. It does not add cache-busting URL parameters or send the page URL; CDN publication and normal edge caching can still delay newly indexed stories. Concurrent forced refreshes join, and superseded ordinary responses cannot overwrite their cache result.

The recent index is required for a complete lookup. If it cannot be fetched, the
extension shows a lookup error instead of a confident negative based on a cached
shard alone. Manifest, recent and shard versions are checked before matching.

## Privacy and security boundaries

- The extension reads completed HTTP(S) tab URLs to provide per-tab badges.
- Exact URLs and full SHA-256 digests remain local during index lookup.
- Cloudflare receives the shard path and standard transport metadata.
- HN receives exact public item IDs when threads are opened or prefetched.
- HN requests omit credentials.
- No analytics, telemetry, advertising, accounts, or payment system exists.
- Session findings and link maps are cleared with the browser session.
- Public HN HTML stored in IndexedDB is bounded and expires.
- The extension executes no remotely hosted code.
- D1 and administrative endpoints are not part of the browser read path.

See [`PRIVACY.md`](../PRIVACY.md) for the user-facing disclosure.

## Tradeoffs and non-goals

- **Prefix privacy is not anonymity.** A 14-bit shard request reveals a candidate set and ordinary network metadata; it does not reveal the exact URL to the index.
- **Normalization trades misses against collisions.** Tracking parameters and known mirrors collapse; unknown query parameters remain because they may select different documents.
- **Metadata is eventually consistent.** Rolling refresh bounds long-term staleness, while item-page parsing corrects expanded discussions immediately.
- **HN HTML is an external contract.** Parser fixtures and sanitizer tests reduce risk, but HN markup changes can require an extension update.
- **Chrome is the current platform.** The side-panel API requires Chrome 114 or newer. Firefox, Safari, and mobile are not currently supported.
- **Self-hosting is operator-oriented, not one-command.** It requires Cloudflare D1, R2, Workers, a historical seed, full regeneration, custom-domain caching, and replacement of the extension's index origin and host permission.


## Panel recovery and verification

The panel retains expanded comments and scroll position when a same-page recheck returns identical submissions. Failed refreshes leave earlier results readable and say they are older. Counts parsed from public HN HTML update the thread heading and total consistently. Every thread offers Refresh comments and Open on HN; comment ages are permalinks. Zero-comment `discuss` pages are distinguished from unrecognized HTML, which is not cached as a valid thread. Cache timestamps include a date when needed.

Tests cover delayed tab queries/lookups, navigation during initial load, repeated refresh and unrelated events, retry and preserved views, disclosure/focus semantics, relative link resolution, fixed expiry, v1 migration, blocked storage upgrades, metadata eviction, MV3 restart caps, closed tabs, delayed badge writes, and prefetch/refresh ordering. Fake IndexedDB is a development-only dependency. DOM tests do not substitute for testing actual Chrome keyboard behavior and side-panel sizing before Store submission.
