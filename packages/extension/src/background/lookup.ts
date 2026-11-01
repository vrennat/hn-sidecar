/**
 * Case B — the user is on an arbitrary page and we ask the index whether
 * HN has discussed it.
 *
 * What leaves the machine is one 14-bit prefix: the name of a file holding a few
 * hundred candidate URL digests. The published 128-bit digest is compared locally,
 * against bytes already downloaded.
 */

import { ARTIFACT_VERSION, NORM_VERSION, hashUrl } from '@hn-sidecar/shared';
import { emptyFinding, type Finding } from '../lib/protocol.ts';
import { toSubmissions, totalComments } from '../lib/submissions.ts';
import { IndexVersionError, getManifest, getRecent, getShard } from './index-client.ts';

export const lookupUrl = async (url: string, refresh = false): Promise<Finding> => {
  const hash = await hashUrl(url);
  if (hash === null) return emptyFinding(url, 'unhashable');

  try {
    /**
     * The manifest is advisory for matching — shards carry their own `nv` — but it is
     * the one place that reveals a whole-index version bump early, before we compare
     * hashes that were computed under different rules and report a confident "no
     * discussion" that is really "I cannot read this index".
     */
    const manifest = await getManifest(refresh).catch(() => null);
    if (manifest !== null && (manifest.nv !== NORM_VERSION || manifest.av !== ARTIFACT_VERSION)) {
      return {
        ...emptyFinding(
          url,
          'version-skew',
          `index is artifact v${manifest.av}/norm v${manifest.nv}, this build implements v${ARTIFACT_VERSION}/v${NORM_VERSION}`,
        ),
        normalized: hash.normalized,
      };
    }

    /**
     * Both files, always. `recent.json` is not a fast path for the shard — it covers
     * the shard's 6 h edge TTL — and a URL can easily have one submission from 2019
     * that only the shard knows and one from this morning that only `recent.json`
     * does. Skipping either loses real results.
     */
    const [recent, shard] = await Promise.all([getRecent(refresh), getShard(hash.shard, refresh)]);
    if (recent.av !== ARTIFACT_VERSION || recent.nv !== NORM_VERSION) {
      throw new IndexVersionError(`recent index is artifact v${recent.av}/norm v${recent.nv}`);
    }

    const merged = [...shard.e, ...recent.entries];
    const submissions = toSubmissions(merged, hash.h);

    return {
      url,
      normalized: hash.normalized,
      source: submissions.length === 0 ? 'none' : 'index',
      submissions,
      totalComments: totalComments(submissions),
      checkedAt: Date.now(),
    };
  } catch (error) {
    const source = error instanceof IndexVersionError ? 'version-skew' : 'error';
    return {
      ...emptyFinding(url, source, error instanceof Error ? error.message : String(error)),
      normalized: hash.normalized,
    };
  }
};
