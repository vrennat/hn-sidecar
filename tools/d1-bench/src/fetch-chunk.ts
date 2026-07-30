/**
 * Step 1: pull a realistic 100K-row chunk to benchmark D1 import against.
 *
 * Rows come from the public ClickHouse playground copy of the HN corpus.
 * Keyset pagination by id is required
 * because the demo user caps a result at ~1 MB. This is ~25 queries — a sample,
 * not the bulk export.
 *
 * `--from` seeds the keyset cursor. This matters for sizing: starting at 0 yields
 * the 2007-2008 corpus, whose URLs and titles are far shorter than modern ones,
 * so any byte-size projection from that slice is biased low.
 *
 *   bun run src/fetch-chunk.ts --count 100000 --out .cache/chunk-old.ndjson
 *   bun run src/fetch-chunk.ts --count 100000 --from 44000000 --out .cache/chunk-modern.ndjson
 */

import { arg } from '@hn-sidecar/toolkit';

const ENDPOINT = 'https://sql-clickhouse.clickhouse.com/?user=demo&default_format=JSONEachRow';

export interface CorpusStory {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly by: string;
  readonly score: number;
  readonly descendants: number;
  readonly ts: number;
}

const page = async (cursor: number): Promise<CorpusStory[]> => {
  const sql = `SELECT id, url, title, by, score, descendants, toUnixTimestamp(time) AS ts
    FROM hackernews.hackernews
    WHERE type = 'story' AND url != '' AND id > ${cursor}
    ORDER BY id LIMIT 200000`;
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    body: sql,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${text.slice(0, 200)}`);
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusStory);
};

const main = async (): Promise<void> => {
  const target = Number.parseInt(arg('count', '100000'), 10);
  const outPath = arg('out', '.cache/chunk-100k.ndjson');

  const rows: CorpusStory[] = [];
  let cursor = Number.parseInt(arg('from', '0'), 10);
  while (rows.length < target) {
    const batch = await page(cursor);
    if (batch.length === 0) break;
    rows.push(...batch);
    const last = batch[batch.length - 1];
    if (last === undefined) break;
    cursor = last.id;
    process.stderr.write(`  ${rows.length}/${target} (cursor ${cursor})\r`);
    // Courtesy pause: this is a free public demo endpoint.
    await Bun.sleep(200);
  }

  const chunk = rows.slice(0, target);
  await Bun.write(outPath, chunk.map((row) => JSON.stringify(row)).join('\n') + '\n');
  console.info(`\nwrote ${chunk.length} rows to ${outPath}`);
};

await main();
