/**
 * The write path, and only the write path.
 *
 * No user request ever reaches this Worker. Reads are static R2 file serves over
 * the index domain, which is what makes "nothing of ours executes when
 * you browse" structurally true rather than a promise. The fetch handler here is
 * an authenticated admin surface for the on-demand regen batch, not a read API.
 */

import { BUCKET_COUNT } from '@hn-sidecar/shared';
import { secretEquals, type Env } from './env.ts';
import { ingest } from './ingest.ts';
import { putManifest } from './publish.ts';
import { regenRange } from './regen.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const authorized = (request: Request, env: Env): boolean => {
  const expected = env.ADMIN_TOKEN;
  if (expected === undefined || expected.length === 0) return false;
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return secretEquals(header.slice(prefix.length), expected);
};

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      ingest(env).then(
        (result) => console.info('ingest', JSON.stringify(result)),
        (error: unknown) => {
          // Log and rethrow: a swallowed failure would look like a healthy cron.
          console.error('ingest failed', error instanceof Error ? error.stack : String(error));
          throw error;
        },
      ),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!authorized(request, env)) {
      // Deliberately opaque: this endpoint's existence is not worth confirming.
      return new Response('not found', { status: 404 });
    }

    if (request.method === 'POST' && url.pathname === '/regen') {
      const from = Number.parseInt(url.searchParams.get('from') ?? '0', 10);
      const to = Number.parseInt(url.searchParams.get('to') ?? String(BUCKET_COUNT), 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > BUCKET_COUNT || from >= to) {
        return json({ error: `bad range ${from}..${to}; expected 0 <= from < to <= ${BUCKET_COUNT}` }, 400);
      }
      const started = Date.now();
      const result = await regenRange(env, from, to);
      return json({ ...result, ms: Date.now() - started });
    }

    /**
     * Separate from /regen on purpose. The manifest must be written after every
     * shard it describes, so it cannot be written by a partial range.
     */
    if (request.method === 'POST' && url.pathname === '/regen/finalize') {
      const total = await env.DB.prepare('SELECT count(*) AS n FROM story_hashes').first<{ n: number }>();
      await putManifest(env, total?.n ?? 0, BUCKET_COUNT);
      return json({ finalized: true, entry_count: total?.n ?? 0, shard_count: BUCKET_COUNT });
    }

    if (request.method === 'POST' && url.pathname === '/ingest') {
      return json(await ingest(env));
    }

    return json({ error: 'unknown route' }, 404);
  },
} satisfies ExportedHandler<Env>;
