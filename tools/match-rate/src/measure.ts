/**
 * Step 2: measure the match rate.
 *
 * The number that matters is: when a user is sitting on a page that HN has a
 * submission for, does the hash their browser computes equal a hash the corpus
 * published? So the two sides are deliberately asymmetric, exactly as in
 * production:
 *
 *   corpus side  — `urlVariants(storedUrl)`, N hashes per story
 *   client side  — `normalizeUrl(finalUrl)`, exactly ONE hash
 *
 * Expanding variants on both sides would inflate the rate and pass a gate the
 * shipped product would fail. `finalUrl` is the post-redirect URL a browser
 * actually shows, which is why every sampled URL is really fetched.
 *
 *   bun run src/measure.ts --in .cache/sample-2y.ndjson --out .cache/results-2y.ndjson
 */

import { normalizeUrl, urlVariants } from '@hn-sidecar/shared';
import { mapLimit } from './concurrency.ts';
import type { SampledStory } from './sample.ts';
import { arg } from '@hn-sidecar/toolkit';

const CONCURRENCY = 12;
const TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 512 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export type Exclusion =
  | 'stored-unnormalizable'
  | 'network-error'
  | 'timeout'
  | 'http-client-error'
  | 'http-server-error'
  | 'bot-challenge'
  | 'not-html';

export interface Result {
  readonly id: number;
  readonly stored: string;
  readonly excluded: Exclusion | null;
  readonly status?: number;
  readonly finalUrl?: string;
  readonly canonicalUrl?: string;
  readonly storedForm?: string;
  readonly finalForm?: string;
  readonly canonicalForm?: string;
  readonly rawEqual?: boolean;
  readonly exactFinal?: boolean;
  readonly variantFinal?: boolean;
  readonly exactCanonical?: boolean;
  readonly variantCanonical?: boolean;
  readonly crossHost?: boolean;
}

const readCapped = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < BODY_CAP_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
};

const CANONICAL_LINK = /<link[^>]+rel=["']?canonical["']?[^>]*>/i;
const OG_URL = /<meta[^>]+property=["']?og:url["']?[^>]*>/i;
const HREF = /(?:href|content)=["']([^"']+)["']/i;

const extractCanonical = (html: string, base: string): string | undefined => {
  for (const pattern of [CANONICAL_LINK, OG_URL]) {
    const tag = pattern.exec(html)?.[0];
    const raw = tag === undefined ? undefined : HREF.exec(tag)?.[1];
    if (raw === undefined || raw.trim().length === 0) continue;
    try {
      return new URL(raw, base).toString();
    } catch {
      continue;
    }
  }
  return undefined;
};

const CHALLENGE_MARKERS = ['just a moment', 'cf-browser-verification', 'enable javascript and cookies', 'are you a robot'];

const measureOne = async (story: SampledStory): Promise<Result> => {
  const storedForm = normalizeUrl(story.url);
  if (storedForm === null) {
    return { id: story.id, stored: story.url, excluded: 'stored-unnormalizable' };
  }

  let response: Response;
  try {
    response = await fetch(story.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*', 'accept-language': 'en-US,en;q=0.9' },
    });
  } catch (error) {
    const timedOut = error instanceof Error && /timeout|abort/i.test(error.name + error.message);
    return { id: story.id, stored: story.url, excluded: timedOut ? 'timeout' : 'network-error' };
  }

  const status = response.status;
  const contentType = response.headers.get('content-type') ?? '';

  // The request timeout can also fire part-way through the body, after fetch()
  // has already resolved — that throw has to be caught here, not above.
  let html = '';
  try {
    html = contentType.includes('html') ? await readCapped(response) : '';
    if (!contentType.includes('html')) await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    const timedOut = error instanceof Error && /timeout|abort/i.test(error.name + error.message);
    return { id: story.id, stored: story.url, excluded: timedOut ? 'timeout' : 'network-error', status };
  }

  if (status === 403 || status === 429 || CHALLENGE_MARKERS.some((marker) => html.toLowerCase().includes(marker))) {
    return { id: story.id, stored: story.url, excluded: 'bot-challenge', status };
  }
  if (status >= 500) return { id: story.id, stored: story.url, excluded: 'http-server-error', status };
  if (status >= 400) return { id: story.id, stored: story.url, excluded: 'http-client-error', status };
  if (!contentType.includes('html')) return { id: story.id, stored: story.url, excluded: 'not-html', status };

  const finalUrl = response.url;
  const canonicalUrl = extractCanonical(html, finalUrl);

  // Corpus side: many hashes. Client side: one.
  const variants = urlVariants(story.url);
  const finalForm = normalizeUrl(finalUrl) ?? undefined;
  const canonicalForm = canonicalUrl === undefined ? undefined : (normalizeUrl(canonicalUrl) ?? undefined);

  let crossHost = false;
  try {
    crossHost = new URL(finalUrl).hostname !== new URL(story.url).hostname;
  } catch {
    crossHost = false;
  }

  return {
    id: story.id,
    stored: story.url,
    excluded: null,
    status,
    finalUrl,
    canonicalUrl,
    storedForm,
    finalForm,
    canonicalForm,
    rawEqual: finalUrl === story.url,
    exactFinal: finalForm !== undefined && finalForm === storedForm,
    variantFinal: finalForm !== undefined && variants.includes(finalForm),
    exactCanonical: canonicalForm !== undefined && canonicalForm === storedForm,
    variantCanonical: canonicalForm !== undefined && variants.includes(canonicalForm),
    crossHost,
  };
};

const main = async (): Promise<void> => {
  const inPath = arg('in', '.cache/sample-2y.ndjson');
  const outPath = arg('out', '.cache/results-2y.ndjson');

  const text = await Bun.file(inPath).text();
  const stories = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SampledStory);

  console.info(`measuring ${stories.length} URLs from ${inPath}`);
  const results = await mapLimit(stories, CONCURRENCY, measureOne, (done, total) => {
    if (done % 25 === 0) process.stderr.write(`  ${done}/${total}\r`);
  });

  await Bun.write(outPath, results.map((result) => JSON.stringify(result)).join('\n') + '\n');
  console.info(`\nwrote ${results.length} results to ${outPath}`);
};

await main();
