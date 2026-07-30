/**
 * Step 3: print the gate number with its denominator.
 *
 *   bun run src/report.ts --in .cache/results-2y.ndjson --mismatches 25
 */

import type { Exclusion, Result } from './measure.ts';
import { arg } from '@hn-sidecar/toolkit';

const pct = (numerator: number, denominator: number): string =>
  denominator === 0 ? 'n/a' : `${((100 * numerator) / denominator).toFixed(1)}%`;

const main = async (): Promise<void> => {
  const inPath = arg('in', '.cache/results-2y.ndjson');
  const mismatchCount = Number.parseInt(arg('mismatches', '25'), 10);

  const text = await Bun.file(inPath).text();
  const results = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Result);

  const excluded = results.filter((result) => result.excluded !== null);
  const scored = results.filter((result) => result.excluded === null);

  const byReason = new Map<Exclusion, number>();
  for (const result of excluded) {
    if (result.excluded === null) continue;
    byReason.set(result.excluded, (byReason.get(result.excluded) ?? 0) + 1);
  }

  const n = scored.length;
  const count = (predicate: (result: Result) => boolean): number => scored.filter(predicate).length;

  const rawEqual = count((r) => r.rawEqual === true);
  const exactFinal = count((r) => r.exactFinal === true);
  const variantFinal = count((r) => r.variantFinal === true);
  const eitherCanonical = count((r) => r.variantFinal === true || r.variantCanonical === true);
  const crossHost = count((r) => r.crossHost === true);

  console.info(`\nsource: ${inPath}`);
  console.info(`sampled: ${results.length}   scored: ${n}   excluded: ${excluded.length}`);
  console.info('\nexclusions (not counted in any rate):');
  for (const [reason, total] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.info(`  ${reason.padEnd(24)} ${String(total).padStart(5)}  ${pct(total, results.length)} of sample`);
  }

  console.info('\nmatch rate — client computes ONE hash from the post-redirect URL:');
  console.info(`  raw string equality (no normalization)   ${String(rawEqual).padStart(5)}/${n}  ${pct(rawEqual, n)}`);
  console.info(`  canonical form only, no variants         ${String(exactFinal).padStart(5)}/${n}  ${pct(exactFinal, n)}`);
  console.info(`  WITH corpus-side variant hashes  <-GATE  ${String(variantFinal).padStart(5)}/${n}  ${pct(variantFinal, n)}`);
  console.info('\ndiagnostic (not the gate — the client cannot read a page canonical before matching):');
  console.info(`  variants vs final OR page canonical      ${String(eitherCanonical).padStart(5)}/${n}  ${pct(eitherCanonical, n)}`);
  console.info(`  redirected to a different host           ${String(crossHost).padStart(5)}/${n}  ${pct(crossHost, n)}`);

  const misses = scored.filter((result) => result.variantFinal !== true);

  // Where a miss lives decides whether it is fixable. A query-only miss is a
  // tracking-param the list does not know yet (cheap). A path or host miss is
  // the site having genuinely moved the document (not fixable by normalization).
  const part = (form: string | undefined): { host: string; path: string; query: string } => {
    const [beforeQuery = '', query = ''] = (form ?? '').split('?');
    const slash = beforeQuery.indexOf('/');
    return {
      host: slash === -1 ? beforeQuery : beforeQuery.slice(0, slash),
      path: slash === -1 ? '' : beforeQuery.slice(slash),
      query,
    };
  };

  const taxonomy = new Map<string, number>();
  for (const miss of misses) {
    const stored = part(miss.storedForm);
    const final = part(miss.finalForm);
    const label =
      miss.finalForm === undefined
        ? 'final-unnormalizable'
        : stored.host !== final.host
          ? 'host differs (rebrand / redirect off-site)'
          : stored.path !== final.path
            ? 'path differs (site moved or rewrote the URL)'
            : 'query only (unknown tracking param — fixable)';
    taxonomy.set(label, (taxonomy.get(label) ?? 0) + 1);
  }

  console.info(`\nmiss taxonomy (${misses.length} misses):`);
  for (const [label, total] of [...taxonomy.entries()].sort((a, b) => b[1] - a[1])) {
    console.info(`  ${label.padEnd(45)} ${String(total).padStart(4)}  ${pct(total, misses.length)} of misses`);
  }

  console.info(`\nsample misses (${Math.min(mismatchCount, misses.length)} of ${misses.length}):`);
  for (const miss of misses.slice(0, mismatchCount)) {
    console.info(`  stored: ${miss.storedForm}`);
    console.info(`  final : ${miss.finalForm}\n`);
  }
};

await main();
