/**
 * Drives the full-regen batch across bucket ranges, then finalizes.
 *
 * The Worker does one range per invocation to stay inside the 10,000
 * subrequests-per-invocation limit (each shard is an R2 put). The manifest is a
 * separate call, made only after every range has succeeded — a manifest that
 * describes shards which were never written is the one failure that makes a
 * client wrong rather than merely stale.
 *
 * Ranges run CONCURRENTLY, which is not a micro-optimisation but the only thing
 * that makes a full regen practical. Measured: within a single invocation, R2 puts
 * do not parallelize — 1,024 puts wrapped in `Promise.all` batches of 40 took
 * 164 s (~160 ms each, i.e. serial), while the D1 reads for the same range took
 * 2.4 s. Since bucket ranges are disjoint, the parallelism has to come from
 * running several invocations at once instead.
 *
 *   ADMIN_TOKEN=... bun run src/regen.ts --worker https://<worker>.workers.dev
 */

import { BUCKET_COUNT } from '@hn-sidecar/shared';
import { arg, intArg } from '@hn-sidecar/toolkit';

const main = async (): Promise<void> => {
  const worker = arg('worker', '').replace(/\/$/, '');
  const rangeSize = intArg('range', 1024);
  const concurrency = intArg('concurrency', 8);
  const token = process.env['ADMIN_TOKEN'] ?? '';

  if (worker.length === 0) throw new Error('--worker <url> is required');
  if (token.length === 0) throw new Error('ADMIN_TOKEN must be set in the environment');

  /** Cloudflare occasionally answers with a transient edge error (e.g. 1042); retry those. */
  const post = async (path: string): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(`${worker}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(600_000),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`POST ${path} -> ${response.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text) as unknown;
      } catch (error) {
        lastError = error;
        await Bun.sleep(2_000 * (attempt + 1));
      }
    }
    throw new Error(`POST ${path} failed after 4 attempts: ${String(lastError)}`);
  };

  const started = Date.now();
  let shards = 0;
  let entries = 0;

  const ranges: { from: number; to: number }[] = [];
  for (let from = 0; from < BUCKET_COUNT; from += rangeSize) {
    ranges.push({ from, to: Math.min(from + rangeSize, BUCKET_COUNT) });
  }

  let next = 0;
  const worker_ = async (): Promise<void> => {
    while (next < ranges.length) {
      const range = ranges[next];
      next += 1;
      if (range === undefined) continue;
      const result = (await post(`/regen?from=${range.from}&to=${range.to}`)) as {
        shards_written: number;
        entries: number;
        d1_ms: number;
        r2_ms: number;
        ms: number;
      };
      shards += result.shards_written;
      entries += result.entries;
      console.info(
        `  buckets ${range.from}..${range.to}  ${result.shards_written} shards, ${result.entries} entries, ` +
          `${(result.ms / 1000).toFixed(0)}s (d1 ${(result.d1_ms / 1000).toFixed(1)}s, r2 ${(result.r2_ms / 1000).toFixed(0)}s)`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker_));

  if (shards !== BUCKET_COUNT) {
    throw new Error(`wrote ${shards} shards but expected ${BUCKET_COUNT}; refusing to publish a manifest`);
  }

  const finalized = await post('/regen/finalize');
  console.info(`\nfinalized: ${JSON.stringify(finalized)}`);

  /**
   * A cron tick landing mid-regen can insert a story into D1 after the regen page
   * for its bucket was already read, leaving it absent from the published shard
   * until that bucket is next touched. Running ingest once afterwards repairs any
   * such straggler, since ingest rewrites every bucket it touches from D1.
   */
  const repair = await post('/ingest');
  console.info(`post-regen ingest: ${JSON.stringify(repair)}`);
  console.info(`${shards} shards, ${entries} entries in ${((Date.now() - started) / 1000).toFixed(0)}s`);
};

await main();
