/**
 * Cross-source URL agreement check.
 *
 * The source experiment seeds history from one source (the 2022 S3 CSV) and crawls
 * Firebase for everything after. If the two sources carry different raw URL text
 * for the same story id — whitespace, percent-encoding, protocol cleanup — hashes
 * diverge at the seam and the index gets silent gaps or duplicate entries.
 *
 * Compares raw bytes and, more importantly, `normalizeUrl` output: raw drift that
 * normalization absorbs is harmless, raw drift that survives it is not.
 *
 *   bun run src/verify-source.ts --in .cache/chunk-modern.ndjson --count 50
 */

import { normalizeUrl } from '@hn-sidecar/shared';
import { arg } from '@hn-sidecar/toolkit';

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

interface Row {
  readonly id: number;
  readonly url: string;
}

const main = async (): Promise<void> => {
  const inPath = arg('in', '.cache/chunk-modern.ndjson');
  const count = Number.parseInt(arg('count', '50'), 10);

  const lines = (await Bun.file(inPath).text()).split('\n').filter((line) => line.trim().length > 0);
  const step = Math.max(1, Math.floor(lines.length / count));
  const sample: Row[] = [];
  for (let index = 0; index < lines.length && sample.length < count; index += step) {
    const line = lines[index];
    if (line === undefined) continue;
    sample.push(JSON.parse(line) as Row);
  }

  let rawMatch = 0;
  let normMatch = 0;
  let missing = 0;
  const drift: string[] = [];

  for (const row of sample) {
    const response = await fetch(`${FIREBASE}/item/${row.id}.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    const item = (await response.json()) as { url?: string } | null;
    const firebaseUrl = item?.url;
    if (firebaseUrl === undefined) {
      missing += 1;
      continue;
    }

    const rawEqual = firebaseUrl === row.url;
    const normEqual = normalizeUrl(firebaseUrl) === normalizeUrl(row.url);
    if (rawEqual) rawMatch += 1;
    if (normEqual) normMatch += 1;
    if (!rawEqual) {
      drift.push(`  id ${row.id}${normEqual ? ' (absorbed by normalization)' : '  <-- SURVIVES NORMALIZATION'}`);
      drift.push(`    bulk    : ${row.url}`);
      drift.push(`    firebase: ${firebaseUrl}`);
    }
  }

  const compared = sample.length - missing;
  console.info(`\nsource: ${inPath}`);
  console.info(`compared ${compared} ids (${missing} absent from Firebase)`);
  console.info(`  raw URL byte-identical      ${rawMatch}/${compared}`);
  console.info(`  normalizeUrl identical      ${normMatch}/${compared}`);
  if (drift.length > 0) {
    console.info('\nraw drift:');
    console.info(drift.join('\n'));
  }
};

await main();
