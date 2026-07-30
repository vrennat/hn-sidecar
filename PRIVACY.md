# Privacy Policy

**Last updated:** July 30, 2026

HN Sidecar is a Chrome extension that shows Hacker News discussions for pages you browse. It handles web browsing activity and public Hacker News content only as described below. It does not sell user data, use it for advertising, or create user profiles.

## URL lookups

When an HTTP or HTTPS tab finishes loading, including a background tab, the extension reads its URL to update that tab's badge. It normalizes and hashes the URL locally using SHA-256, then uses the first 14 bits to select one of 16,384 static index shards at `hn-index.tanner.place`.

- The exact URL and full SHA-256 digest are not sent to the index host.
- The downloaded shard contains 128-bit truncated digests for candidate URLs. Matching happens locally in the extension.
- The extension also fetches non-URL-specific index metadata (`manifest.json` and `recent.json`).
- The index host and its infrastructure provider, Cloudflare, receive standard HTTPS request metadata such as the IP address, user agent, timestamp, and requested path. The extension adds no account identifier or tracking identifier.
- The read path consists only of static files; it does not call an application API or record whether a local match was found.

## Hacker News requests

When a discussion is opened or prefetched following interaction with a Hacker News link, the extension requests the public item page from `news.ycombinator.com` using `credentials: 'omit'`.

- The user's Hacker News login cookie is not sent.
- Hacker News and its infrastructure providers receive standard request metadata and the requested public item ID.
- The returned HTML is parsed and sanitized locally before display.

A content script also reads public Hacker News listing pages to build a session-local map between story links and discussions. It does not read page content on other sites.

## Local storage

| Storage | Contents | Retention |
|---|---|---|
| `chrome.storage.session` | URL findings, Hacker News link maps, and downloaded index artifacts | Cleared when the browser session ends |
| IndexedDB (`hn-sidecar`, `threads`) | Raw HTML for public Hacker News item pages | Approximately 40 MB maximum; 10-minute TTL for stories under 24 hours old and 30-day TTL otherwise; least-recently-used entries are evicted at the cap |

Users can remove all locally stored extension data by uninstalling HN Sidecar or clearing the extension's site data in Chrome.

## Collection, use, and sharing

HN Sidecar has:

- no user accounts, registration, or payments;
- no analytics, telemetry, advertising, or error-reporting service;
- no sale of user data;
- no use of browsing activity outside the feature of finding Hacker News discussions.

Cloudflare processes standard request metadata as the infrastructure provider for the static index. Hacker News processes requests for its public item pages. These transfers are necessary to provide the extension's single user-facing purpose. Infrastructure providers may retain standard service logs under their own policies; HN Sidecar does not maintain an application database of users' browsing or lookup history.

HN Sidecar's use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Changes

Material changes to this policy will be published here and accompanied by an extension update when they affect extension behavior.

## Contact

For privacy questions, open an issue at https://github.com/vrennat/hn-sidecar/issues. Do not include sensitive personal information in a public issue.
