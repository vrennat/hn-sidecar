/**
 * Seed crawl. Writes NDJSON, resumable, checkpointed, rate-ceilinged.
 *
 *   # 2-year seed from the bulk copy (~135 queries, ~2 min)
 *   bun run src/crawl.ts --years 2 --source clickhouse --out .cache/seed-2y.ndjson
 *
 *   # same window from the official API (~8.0M ids, hours; resume by re-running)
 *   bun run src/crawl.ts --years 2 --source firebase --rps 50 --out .cache/seed-2y.ndjson
 *
 * Re-running with the same --out resumes from the checkpoint beside it.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertResumable, readCheckpoint, writeCheckpoint } from './checkpoint.ts';
import { clickhouseSource, firebaseSource, type SeedSource, type SeedStory } from './sources.ts';
import { arg } from '@hn-sidecar/toolkit';

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

/** Lowest item id posted at or after `cutoff`. Binary search; ids are time-ordered. */
const idAtTime = async (cutoff: number, maxItem: number): Promise<number> => {
  let low = 1;
  let high = maxItem;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const response = await fetch(`${FIREBASE}/item/${mid}.json`, {
      signal: AbortSignal.timeout(15_000),
    });
    const item = (await response.json()) as { time?: number } | null;
    const time = item?.time;
    if (time === undefined) {
      // Deleted item: probe forward for the nearest timestamped neighbour.
      let probe = mid + 1;
      let probed: number | undefined;
      while (probe < high && probed === undefined) {
        const next = await fetch(`${FIREBASE}/item/${probe}.json`, {
          signal: AbortSignal.timeout(15_000),
        });
        probed = ((await next.json()) as { time?: number } | null)?.time;
        probe += 1;
      }
      if (probed === undefined) high = mid;
      else if (probed < cutoff) low = probe;
      else high = mid;
      continue;
    }
    if (time < cutoff) low = mid + 1;
    else high = mid;
  }
  return low;
};

const countLines = async (path: string): Promise<number> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return 0;
  const text = await file.text();
  return text.split('\n').filter((line) => line.trim().length > 0).length;
};

const main = async (): Promise<void> => {
  const years = Number.parseFloat(arg('years', '2'));
  const sourceName = arg('source', 'clickhouse');
  const rps = Number.parseInt(arg('rps', '50'), 10);
  const outPath = arg('out', '.cache/seed-2y.ndjson');
  const checkpointPath = `${outPath}.checkpoint.json`;

  if (sourceName === 'firebase' && rps > 50) {
    throw new Error(`--rps ${rps} exceeds the politeness ceiling of 50; refusing`);
  }
  const source: SeedSource =
    sourceName === 'firebase' ? firebaseSource(rps) : sourceName === 'clickhouse' ? clickhouseSource : (() => {
      throw new Error(`unknown --source "${sourceName}" (expected clickhouse or firebase)`);
    })();

  const maxItem = (await (await fetch(`${FIREBASE}/maxitem.json`)).json()) as number;
  const cutoff = Math.floor(Date.now() / 1000) - years * 365.25 * 24 * 3600;
  const lowId = await idAtTime(cutoff, maxItem);

  const existing = await readCheckpoint(checkpointPath);
  if (existing !== null) {
    assertResumable(existing, source.name, await countLines(outPath));
    console.info(`resuming ${source.name} at cursor ${existing.cursor} (${existing.written} rows written)`);
  } else {
    console.info(`starting ${source.name} crawl over ids ${lowId}..${maxItem} (${years}y window)`);
  }

  let cursor = existing?.cursor ?? lowId - 1;
  let written = existing?.written ?? 0;
  await mkdir(dirname(outPath), { recursive: true });
  // Append, never truncate: a resumed run must not destroy the prefix its
  // checkpoint refers to.
  const writer = createWriteStream(outPath, { flags: 'a' });
  const started = Date.now();

  for (;;) {
    const { stories, nextCursor, done } = await source.page(cursor, maxItem);

    // One write per page, then honour backpressure. Awaiting a callback on an
    // empty write does NOT work — Node may skip a zero-length chunk entirely and
    // the callback never fires, which hangs the crawl with the checkpoint one
    // page behind the file.
    if (stories.length > 0) {
      const payload = (stories as SeedStory[]).map((story) => `${JSON.stringify(story)}\n`).join('');
      written += stories.length;
      if (!writer.write(payload)) {
        await new Promise<void>((resolve, reject) => {
          writer.once('drain', resolve);
          writer.once('error', reject);
        });
      }
    }
    cursor = nextCursor;
    // Checkpoint only after the rows are flushed, so a crash can never leave the
    // checkpoint ahead of the file.
    await writeCheckpoint(checkpointPath, {
      cursor,
      written,
      source: source.name,
      updated_at: Math.floor(Date.now() / 1000),
    });

    const elapsed = (Date.now() - started) / 1000;
    process.stderr.write(
      `  cursor ${cursor}/${maxItem}  ${written} stories  ${elapsed.toFixed(0)}s\r`,
    );
    if (done) break;
  }

  await new Promise<void>((resolve) => writer.end(resolve));
  console.info(`\nwrote ${written} stories to ${outPath} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
};

await main();
