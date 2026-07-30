/**
 * End-to-end verification of the published index, over HTTP, as a client sees it.
 *
 * This is the check that the write path actually produced a working read path:
 * take real story URLs, normalize and hash them client-side exactly as the
 * extension will, fetch the shard from the public index origin, and assert the
 * published 128-bit digest is present with the right story id.
 *
 *   bun run src/verify.ts --origin https://pub-xxx.r2.dev --seed ../seed/.cache/seed-2y.ndjson
 */

import {
  ARTIFACT_VERSION,
  MANIFEST_KEY,
  NORM_VERSION,
  RECENT_KEY,
  SHARD_KEY,
  hashUrl,
  type Manifest,
  type RecentIndex,
  type Shard,
} from '@hn-sidecar/shared';
import { arg, intArg } from '@hn-sidecar/toolkit';

interface SeedStory {
  readonly id: number;
  readonly url: string;
  readonly title: string;
}

const getJson = async <T>(url: string): Promise<{ body: T; headers: Headers }> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return { body: (await response.json()) as T, headers: response.headers };
};

const main = async (): Promise<void> => {
  const origin = arg('origin', '').replace(/\/$/, '');
  const seedPath = arg('seed', '../seed/.cache/seed-2y.ndjson');
  const sampleSize = intArg('count', 200);
  if (origin.length === 0) throw new Error('--origin <url> is required');

  const manifest = await getJson<Manifest>(`${origin}/${MANIFEST_KEY}`);
  console.info(`manifest: ${JSON.stringify(manifest.body)}`);
  if (manifest.body.nv !== NORM_VERSION) {
    throw new Error(`manifest norm_version ${manifest.body.nv} != client ${NORM_VERSION}`);
  }
  if (manifest.body.av !== ARTIFACT_VERSION) {
    throw new Error(`manifest artifact_version ${manifest.body.av} != client ${ARTIFACT_VERSION}`);
  }

  const recent = await getJson<RecentIndex>(`${origin}/${RECENT_KEY}`);
  console.info(`recent.json: ${recent.body.entries.length} entries, generated_at ${recent.body.generated_at}`);

  // Sample evenly across the seed rather than taking the head, so the check spans
  // the whole id range and therefore the whole bucket space.
  const lines = (await Bun.file(seedPath).text()).split('\n').filter((line) => line.trim().length > 0);
  const step = Math.max(1, Math.floor(lines.length / sampleSize));
  const sample: SeedStory[] = [];
  for (let index = 0; index < lines.length && sample.length < sampleSize; index += step) {
    const line = lines[index];
    if (line !== undefined) sample.push(JSON.parse(line) as SeedStory);
  }

  let matched = 0;
  let missing = 0;
  let unhashable = 0;
  const shardCache = new Map<string, Shard>();
  const failures: string[] = [];

  for (const story of sample) {
    const hash = await hashUrl(story.url);
    if (hash === null) {
      unhashable += 1;
      continue;
    }
    let shard = shardCache.get(hash.shard);
    if (shard === undefined) {
      shard = (await getJson<Shard>(`${origin}/${SHARD_KEY(hash.shard)}`)).body;
      shardCache.set(hash.shard, shard);
      if (shard.b !== hash.shard) throw new Error(`shard ${hash.shard} self-reports as ${shard.b}`);
      if (shard.nv !== NORM_VERSION) throw new Error(`shard ${hash.shard} norm_version ${shard.nv}`);
    }
    const hit = shard.e.find((entry) => entry.h === hash.h && entry.id === story.id);
    if (hit === undefined) {
      missing += 1;
      if (failures.length < 10) failures.push(`  id ${story.id} h ${hash.h} shard ${hash.shard}: ${story.url}`);
      continue;
    }
    matched += 1;
  }

  console.info(`\nround-trip over ${sample.length} seeded URLs:`);
  console.info(`  matched   ${matched}`);
  console.info(`  missing   ${missing}`);
  console.info(`  unhashable ${unhashable}`);
  console.info(`  distinct shards fetched ${shardCache.size}`);
  if (failures.length > 0) console.info(`\nfailures:\n${failures.join('\n')}`);

  const sizes = [...shardCache.values()].map((shard) => JSON.stringify(shard).length);
  if (sizes.length > 0) {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const entries = [...shardCache.values()].reduce((sum, shard) => sum + shard.e.length, 0);
    console.info(
      `\nshard size: mean ${(total / sizes.length / 1024).toFixed(1)} KB raw, ` +
        `max ${(Math.max(...sizes) / 1024).toFixed(1)} KB, ` +
        `mean ${(entries / sizes.length).toFixed(0)} entries`,
    );
  }

  if (missing > 0) throw new Error(`${missing} seeded URLs did not round-trip through the published index`);
};

await main();
