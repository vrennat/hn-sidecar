/**
 * Step 1: draw a uniform random sample of real HN story submissions.
 *
 * Sampling is by item id, which HN assigns sequentially in time, so a uniform
 * draw over an id range is a uniform draw over items posted in that window. Most
 * items are comments, so reaching N stories costs roughly 20N item fetches.
 *
 *   bun run src/sample.ts --years 2 --count 1000 --out .cache/sample-2y.ndjson
 *   bun run src/sample.ts --years all --count 300 --out .cache/sample-all.ndjson
 */

import { mapLimit } from './concurrency.ts';
import { arg } from '@hn-sidecar/toolkit';

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';
/** Politeness ceiling; this run is far below it. */
const CONCURRENCY = 20;
/** HN item 1 was posted 2006-10-09. */
const FIRST_ITEM_ID = 1;

export interface SampledStory {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly time: number;
}

interface FirebaseItem {
  readonly id?: number;
  readonly type?: string;
  readonly url?: string;
  readonly title?: string;
  readonly time?: number;
  readonly dead?: boolean;
  readonly deleted?: boolean;
}

const fetchItem = async (id: number): Promise<FirebaseItem | null> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${FIREBASE}/item/${id}.json`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as FirebaseItem | null;
    } catch {
      await Bun.sleep(250 * (attempt + 1));
    }
  }
  return null;
};

/** Binary search for the lowest item id posted at or after `cutoff` (unix seconds). */
const idAtTime = async (cutoff: number, maxItem: number): Promise<number> => {
  let low = FIRST_ITEM_ID;
  let high = maxItem;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = await fetchItem(mid);
    const time = item?.time;
    // Deleted items return null; step forward until a timestamped item is found.
    if (time === undefined) {
      let probe = mid + 1;
      let probed: number | undefined;
      while (probe < high && probed === undefined) {
        probed = (await fetchItem(probe))?.time;
        probe += 1;
      }
      if (probed === undefined) {
        high = mid;
        continue;
      }
      if (probed < cutoff) low = probe;
      else high = mid;
      continue;
    }
    if (time < cutoff) low = mid + 1;
    else high = mid;
  }
  return low;
};

const main = async (): Promise<void> => {
  const years = arg('years', '2');
  const target = Number.parseInt(arg('count', '1000'), 10);
  const outPath = arg('out', `.cache/sample-${years}.ndjson`);

  const maxItemResponse = await fetch(`${FIREBASE}/maxitem.json`);
  const maxItem = (await maxItemResponse.json()) as number;

  const now = Math.floor(Date.now() / 1000);
  const lowId =
    years === 'all'
      ? FIRST_ITEM_ID
      : await idAtTime(now - Number.parseFloat(years) * 365.25 * 24 * 3600, maxItem);

  console.info(`sampling ids ${lowId}..${maxItem} (window: ${years}), target ${target} stories`);

  const stories: SampledStory[] = [];
  const seen = new Set<number>();
  const span = maxItem - lowId;

  while (stories.length < target) {
    const batch: number[] = [];
    // Overshoot: roughly 1 in 20 items is a story with a URL.
    const wanted = Math.min(2_000, (target - stories.length) * 25);
    while (batch.length < wanted) {
      const id = lowId + Math.floor(Math.random() * span);
      if (seen.has(id)) continue;
      seen.add(id);
      batch.push(id);
    }

    const items = await mapLimit(batch, CONCURRENCY, fetchItem, (done, total) => {
      if (done % 500 === 0) process.stderr.write(`  probed ${done}/${total}\r`);
    });

    for (const item of items) {
      if (item === null || item === undefined) continue;
      if (item.type !== 'story') continue;
      if (item.dead === true || item.deleted === true) continue;
      const { id, url, title, time } = item;
      // Firebase returns url: "" for text posts, not an absent field.
      if (id === undefined || url === undefined || url === '' || title === undefined || time === undefined) continue;
      stories.push({ id, url, title, time });
      if (stories.length >= target) break;
    }
    console.info(`\n  ${stories.length}/${target} stories, ${seen.size} items probed`);
  }

  await Bun.write(outPath, stories.map((story) => JSON.stringify(story)).join('\n') + '\n');
  const oldest = new Date(Math.min(...stories.map((s) => s.time)) * 1000).toISOString().slice(0, 10);
  const newest = new Date(Math.max(...stories.map((s) => s.time)) * 1000).toISOString().slice(0, 10);
  console.info(`wrote ${stories.length} stories to ${outPath} (${oldest} .. ${newest})`);
};

await main();
