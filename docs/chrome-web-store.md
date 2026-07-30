# Chrome Web Store submission dossier

This file contains the copy and declarations for HN Sidecar 0.1.0. Keep the dashboard answers, `PRIVACY.md`, and extension behavior consistent.

## Listing copy

**Name:** HN Sidecar

**Category:** Productivity

**Language:** English (United States)

**Summary (70 characters):**

> Find and read Hacker News discussions for the page in your active tab.

**Detailed description:**

> HN Sidecar adds an orange badge to the toolbar when the page you are viewing has been discussed on Hacker News. Click the icon, or press Alt+H, to open the discussions and read comment threads in Chrome's side panel.
>
> Features:
>
> - Finds previous Hacker News submissions for pages as you browse.
> - Shows comment counts directly on the toolbar badge.
> - Renders Hacker News comment threads in a persistent side panel.
> - Recognizes links followed from Hacker News without another index lookup.
> - Uses no accounts, analytics, ads, or telemetry.
>
> URL matching is privacy-conscious: the extension normalizes and hashes each URL locally, requests a static index shard selected by a 14-bit prefix, and compares candidate digests on the device. The exact page URL is not sent to the index service.
>
> HN Sidecar is open source under the MIT license and is not affiliated with Hacker News or Y Combinator.

**Support URL:** https://github.com/vrennat/hn-sidecar/issues

**Homepage URL:** https://github.com/vrennat/hn-sidecar

## Privacy tab

### Single purpose

> Show the Hacker News discussions associated with pages the user browses and render those public discussions in Chrome's side panel.

### Permission justifications

#### `tabs`

> Required to read HTTP(S) tab URLs after navigation, look up the corresponding Hacker News discussions, maintain a per-tab result, and set each tab's badge. The side panel also reads the active tab ID and URL so it displays the correct result. The extension does not use tab data for analytics, advertising, or profiling.

#### `storage`

> Required for `chrome.storage.session`, which caches per-tab findings, Hacker News link mappings, and downloaded static index artifacts across Manifest V3 service-worker restarts. Session storage is cleared when the browser session ends. The extension does not request `unlimitedStorage`.

#### `sidePanel`

> Required to display Hacker News discussions in Chrome's side panel when the user clicks the toolbar icon or invokes Alt+H.

### Host permission justifications

#### `https://news.ycombinator.com/*`

> Required for the content script to read public Hacker News listing pages and build a session-local map from story links to discussions. It is also required to fetch public HN item pages when a discussion is opened or prefetched. Item-page requests use `credentials: 'omit'`, so the user's Hacker News login cookie is not sent. No other site's page content is read.

#### `https://hn-index.tanner.place/*`

> Required to fetch static index metadata and JSON shards. A shard path is selected from the first 14 bits of a locally computed URL hash. The exact page URL and full SHA-256 digest are not sent to this host; candidate 128-bit digests are compared locally. The permission is limited to the single static index origin.

### Remote code

**Answer:** No, this extension does not use remote code.

> All executable code is included in the submitted package. Remote responses are data only: static JSON index artifacts and public Hacker News HTML. The extension never evaluates fetched strings or loads remote scripts. Hacker News HTML is parsed and rebuilt through a local allowlist sanitizer before display.

### User data disclosures

Disclose these categories even though much of the processing is local:

- **Web history / browsing activity:** HTTP(S) tab URLs are read to provide per-tab discussion badges. The exact URL is processed locally; a 14-bit hash prefix is reflected in the requested static shard path.
- **Website content:** the extension reads public Hacker News listing pages and fetches public HN item pages to identify and render discussions.

Do not select personally identifiable information, authentication information, personal communications, location, financial information, or health information. The extension does not collect those categories.

Certify the Limited Use statements. In particular, the data is used only for the disclosed feature, is not sold or used for advertising, and is not used for creditworthiness or lending.

### Privacy policy URL

https://github.com/vrennat/hn-sidecar/blob/main/PRIVACY.md

This URL will work only after the repository is public.

## Reviewer test instructions

> 1. Install the submitted extension and navigate to https://fly.io/blog/youre-all-nuts/.
> 2. Wait for the page to finish loading. Verify the toolbar badge shows a numeric Hacker News comment count rather than a blank badge or `?`.
> 3. Click the extension icon or press Alt+H. Verify the side panel opens, lists at least one Hacker News submission, automatically expands the newest discussion, and renders comments.
> 4. Navigate to the negative control https://example.com/hn-sidecar-negative-control-9f3a2b. Verify the badge is blank and the panel says `No HN discussion found for this page.`
> 5. Navigate to https://news.ycombinator.com/. Open the panel and verify it says `You are on Hacker News — nothing to look up here.` Follow a story link from the listing and verify the destination receives a numeric badge.
>
> No account or test credentials are required.

## Package and assets

Generate the package with:

```bash
bun run package:extension
```

Upload `packages/extension/release/hn-sidecar-0.1.0.zip`. Its `manifest.json` is at the ZIP root.

| Asset | Requirement | Repository path | Status |
|---|---|---|---|
| Extension/store icon | 128x128 PNG in extension ZIP | `packages/extension/assets/icon-128.png` | Ready |
| Small promotional image | 440x280 PNG | `docs/store-assets/promo.png` | Ready |
| Screenshot | 1280x800 or 640x400, full bleed | `docs/store-assets/screenshot-01.png` | Ready |
| Marquee image | 1400x560 PNG, optional | — | Optional |

Before uploading a screenshot, verify that it shows the current extension UI, contains no private browser data, and is not a mockup.

## Publisher prerequisites

- Register a Chrome Web Store developer account and pay the one-time fee shown in the dashboard.
- Set a publisher name.
- Verify the developer contact email.
- Upload the ZIP and complete the Store Listing, Privacy, Distribution, and Test Instructions tabs.
- Choose public distribution.
- Use deferred publishing if approval timing should not automatically determine the launch time.

Chrome's documentation says most reviews finish within a few days, but reviews can take several weeks. A new developer and a new extension may receive additional scrutiny. Do not make tomorrow's Hacker News post depend on store approval.

## Final checklist

- [ ] Repository is public, so homepage, support, and privacy URLs resolve without authentication.
- [ ] `bun install --frozen-lockfile`, typecheck, tests, build, and packaging pass from a clean clone.
- [ ] ZIP uploaded; icon is visible and manifest permissions match this dossier.
- [ ] Current screenshot uploaded.
- [ ] Small promotional image uploaded.
- [ ] Single purpose, permissions, remote-code answer, and data disclosures pasted from this file.
- [ ] Privacy policy URL opens in a signed-out browser.
- [ ] Reviewer instructions pasted and tested against the uploaded build.
- [ ] Distribution set to Public.
- [ ] Submission uses deferred publishing if launch timing matters.
