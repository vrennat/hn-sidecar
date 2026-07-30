/**
 * Chunked D1 import of the seed NDJSON.
 *
 * Emits SQL chunks and runs them through `wrangler d1 execute --remote --file`,
 * which uploads the file and imports it server-side. The D1 benchmark measured 100K stories
 * per chunk at ~5 s, so chunk size is set there.
 *
 *   bun run src/import.ts --in .cache/seed-2y.ndjson --db hn-sidecar
 *   bun run src/import.ts --in .cache/seed-2y.ndjson --db hn-sidecar --sql-only
 */

import { mkdir } from 'node:fs/promises';
import { hashNormalized, urlVariants } from '@hn-sidecar/shared';
import type { SeedStory } from './sources.ts';
import { arg, flag } from '@hn-sidecar/toolkit';

const STORIES_PER_CHUNK = 100_000;
const ROWS_PER_STATEMENT = 500;

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const statements = (table: string, columns: readonly string[], rows: readonly string[]): string => {
  const out: string[] = [];
  for (let offset = 0; offset < rows.length; offset += ROWS_PER_STATEMENT) {
    const slice = rows.slice(offset, offset + ROWS_PER_STATEMENT);
    out.push(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES\n${slice.join(',\n')};`);
  }
  return out.join('\n');
};

/**
 * Runs through a shell: `wrangler` on PATH is a package-manager shim, and spawning
 * it directly makes Bun try to reinstall its own binary.
 */
const run = async (command: string): Promise<void> => {
  const proc = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command} exited ${code}\n${out}\n${err}`);
};

const main = async (): Promise<void> => {
  const inPath = arg('in', '.cache/seed-2y.ndjson');
  const database = arg('db', 'hn-sidecar');
  const outDir = arg('sql-dir', '.cache/import-sql');
  const sqlOnly = flag('sql-only');

  const text = await Bun.file(inPath).text();
  // A resumed crawl can re-append rows already present (the checkpoint lags the
  // file by design), so dedupe by id — last occurrence wins.
  const byId = new Map<number, SeedStory>();
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const story = JSON.parse(line) as SeedStory;
    byId.set(story.id, story);
  }
  const stories = [...byId.values()].sort((left, right) => left.id - right.id);
  console.info(`${stories.length} unique stories from ${inPath} (${text.split('\n').length - 1} lines read)`);

  await mkdir(outDir, { recursive: true });
  const chunkCount = Math.ceil(stories.length / STORIES_PER_CHUNK);
  let totalHashRows = 0;
  let unnormalizable = 0;

  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    const slice = stories.slice(chunk * STORIES_PER_CHUNK, (chunk + 1) * STORIES_PER_CHUNK);
    const storyValues: string[] = [];
    const hashValues: string[] = [];

    for (const story of slice) {
      storyValues.push(
        `(${story.id}, ${quote(story.url)}, ${quote(story.title)}, ${quote(story.by)}, ` +
          `${story.score}, ${story.descendants}, ${story.ts})`,
      );
      const variants = urlVariants(story.url);
      if (variants.length === 0) {
        unnormalizable += 1;
        continue;
      }
      for (const variant of variants) {
        const { h, bucket } = await hashNormalized(variant);
        hashValues.push(`(${story.id}, ${quote(h)}, ${bucket})`);
      }
    }
    totalHashRows += hashValues.length;

    const path = `${outDir}/chunk-${String(chunk).padStart(3, '0')}.sql`;
    await Bun.write(
      path,
      [
        statements('stories', ['id', 'url', 'title', 'by', 'score', 'descendants', 'ts'], storyValues),
        statements('story_hashes', ['story_id', 'h', 'bucket'], hashValues),
      ].join('\n'),
    );

    const megabytes = (Bun.file(path).size / 1e6).toFixed(1);
    if (sqlOnly) {
      console.info(`  ${path}  ${slice.length} stories, ${hashValues.length} hashes, ${megabytes} MB`);
      continue;
    }
    const started = Date.now();
    await run(`wrangler d1 execute '${database}' --remote --file='${path}' -y`);
    console.info(
      `  chunk ${chunk + 1}/${chunkCount}  ${slice.length} stories, ${hashValues.length} hashes, ` +
        `${megabytes} MB, ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }

  console.info(`\n${stories.length} stories, ${totalHashRows} hash rows (${(totalHashRows / stories.length).toFixed(2)} per story)`);
  if (unnormalizable > 0) console.info(`${unnormalizable} stories had unnormalizable URLs and no hash rows`);

  /**
   * Hand the ingest cron a watermark, or it leaves a permanent hole.
   *
   * On a null watermark, ingest starts from the *current* maxitem — so every id
   * between the seed's last story and whenever the first tick fires is never
   * examined, and those stories are absent forever unless `updates.json` happens
   * to surface them. Observed: a ~160-id gap on this seed. It would recur on
   * every future seed.
   *
   * Seeding the watermark to the seed's own high-water mark makes the first tick
   * walk that seam instead of skipping it.
   */
  const highWaterMark = stories[stories.length - 1]?.id;
  if (highWaterMark !== undefined && !sqlOnly) {
    await run(
      `wrangler d1 execute '${database}' --remote -y --command ` +
        `"INSERT OR REPLACE INTO meta (key, value) VALUES ('last_max_item', '${highWaterMark}')"`,
    );
    console.info(`watermark set to ${highWaterMark}; the next ingest tick backfills the seam`);
  }
};

await main();
