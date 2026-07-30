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

The background service worker listens for completed HTTP(S) tab navigations. Each tab gets an independent finding and badge. Sequence guards prevent a slow lookup for a previous page from overwriting a newer navigation's result.

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

Thread HTML is cached in IndexedDB with a roughly 40 MB LRU cap. Stories younger than 24 hours use a 10-minute TTL; older stories use a 30-day TTL.

## Index write path

### Historical seed

The seed tools produce resumable NDJSON, normalize and hash story URLs, import stories plus digest rows into D1, and initialize the ingest watermark. D1 retains raw URLs because a normalization-version change requires recomputing every digest.

The public extension does not need a local seed or Cloudflare account; it uses the hosted index by default.

### Scheduled ingest

The Worker runs every 10 minutes. It:

1. Reads HN's current `maxitem` and the stored watermark.
2. Fetches new item IDs plus the small `/updates.json` set.
3. Upserts URL-bearing stories into D1.
4. Replaces each changed story's digest rows.
5. Rewrites both newly touched and previously occupied shards.
6. Publishes the 48-hour recent index.
7. Writes the manifest last.
8. Advances the watermark.

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

Inside the extension, session caches use shorter TTLs: five minutes for manifest/recent, one hour for shards, and 30 minutes for per-tab findings and HN link-map entries.

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
