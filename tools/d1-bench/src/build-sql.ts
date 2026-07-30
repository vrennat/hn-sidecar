/**
 * Step 2: turn the fetched chunk into SQL files that `wrangler d1 execute
 * --file` can import, and report the artifact sizes that drive import time.
 *
 * Rows are emitted as multi-row INSERTs (statement count, not row count, is what
 * D1's import path is sensitive to). Hash rows are computed here with the same
 * shared code the ingest Worker uses, so the benchmark exercises the real shape:
 * ~1.3 hash rows per story once variants are counted.
 *
 *   bun run src/build-sql.ts --in .cache/chunk-100k.ndjson --out .cache/sql
 */

import { hashNormalized, urlVariants } from '@hn-sidecar/shared';
import type { CorpusStory } from './fetch-chunk.ts';
import { arg } from '@hn-sidecar/toolkit';

const ROWS_PER_STATEMENT = 500;

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const writeInserts = async (
  path: string,
  table: string,
  columns: readonly string[],
  rows: readonly string[],
): Promise<number> => {
  const statements: string[] = [];
  for (let offset = 0; offset < rows.length; offset += ROWS_PER_STATEMENT) {
    const slice = rows.slice(offset, offset + ROWS_PER_STATEMENT);
    statements.push(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES\n${slice.join(',\n')};`,
    );
  }
  await Bun.write(path, statements.join('\n'));
  return statements.length;
};

const main = async (): Promise<void> => {
  const inPath = arg('in', '.cache/chunk-100k.ndjson');
  const outDir = arg('out', '.cache/sql');

  const text = await Bun.file(inPath).text();
  const stories = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusStory);

  const storyValues: string[] = [];
  const hashValues: string[] = [];
  let unnormalizable = 0;

  for (const story of stories) {
    storyValues.push(
      `(${story.id}, ${quote(story.url)}, ${quote(story.title)}, ${quote(story.by)}, ` +
        `${story.score}, ${story.descendants}, ${story.ts})`,
    );
    const variants = urlVariants(story.url);
    if (variants.length === 0) unnormalizable += 1;
    for (const variant of variants) {
      const { h, bucket } = await hashNormalized(variant);
      hashValues.push(`(${story.id}, ${quote(h)}, ${bucket})`);
    }
  }

  const storiesPath = `${outDir}/stories.sql`;
  const hashesPath = `${outDir}/hashes.sql`;
  const storyStatements = await writeInserts(storiesPath, 'stories', ['id', 'url', 'title', 'by', 'score', 'descendants', 'ts'], storyValues);
  const hashStatements = await writeInserts(hashesPath, 'story_hashes', ['story_id', 'h', 'bucket'], hashValues);

  const storiesBytes = Bun.file(storiesPath).size;
  const hashesBytes = Bun.file(hashesPath).size;

  console.info(`stories        ${storyValues.length} rows, ${storyStatements} statements, ${(storiesBytes / 1e6).toFixed(1)} MB`);
  console.info(`story_hashes   ${hashValues.length} rows, ${hashStatements} statements, ${(hashesBytes / 1e6).toFixed(1)} MB`);
  console.info(`hash rows per story: ${(hashValues.length / stories.length).toFixed(2)}`);
  console.info(`unnormalizable URLs: ${unnormalizable} (${((100 * unnormalizable) / stories.length).toFixed(2)}%)`);
};

await main();
