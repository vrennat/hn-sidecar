-- D1 is the build-time authority. Raw URLs live here and nowhere else,
-- because shards store only hashes and a NORM_VERSION rebuild must re-normalize
-- from raw. Never queried at read time — no user request reaches this database.

CREATE TABLE IF NOT EXISTS stories (
  id           INTEGER PRIMARY KEY,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  by           TEXT NOT NULL,
  score        INTEGER NOT NULL,
  descendants  INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  -- Last time this row's score/descendants were re-checked against Firebase.
  -- HN exposes no "stories modified since X" signal beyond the comment-centric
  -- updates.json, so ingest re-fetches the stalest rows each tick to keep the
  -- badge's counts honest. 0 marks a never-refreshed (seeded/legacy) row, which
  -- the stalest-first re-fetch naturally drains first.
  refreshed_at INTEGER NOT NULL DEFAULT 0
);

-- Stories touched in the last 48 h drive recent.json; ingest queries by ts.
CREATE INDEX IF NOT EXISTS stories_ts ON stories (ts);

-- The rolling re-fetch's only access pattern: the K stalest rows.
CREATE INDEX IF NOT EXISTS stories_refreshed_at ON stories (refreshed_at, ts);

-- One row per (story, variant hash). `bucket` is the high 14 bits of the digest
-- as defined in packages/shared/src/hash.ts — the single definition.
--
-- Rows here are derived from stories.url. Any ingest that changes a story's URL
-- MUST delete this story's rows before reinserting, or stale variants survive and
-- keep matching a URL the story no longer has.
CREATE TABLE IF NOT EXISTS story_hashes (
  story_id INTEGER NOT NULL,
  h        TEXT NOT NULL,
  bucket   INTEGER NOT NULL,
  PRIMARY KEY (story_id, h)
);

-- The regen batch's only access pattern: every hash in a bucket range, ordered.
CREATE INDEX IF NOT EXISTS story_hashes_bucket ON story_hashes (bucket, story_id);

-- Small key/value state for the write path: the ingest watermark, mostly.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- === Migration for databases created before `refreshed_at` existed ===
-- Run once against the live database before deploying the new ingest:
--   wrangler d1 execute hn-sidecar --remote --command "ALTER TABLE stories ADD COLUMN refreshed_at INTEGER NOT NULL DEFAULT 0;"
--   wrangler d1 execute hn-sidecar --remote --command "CREATE INDEX IF NOT EXISTS stories_refreshed_at ON stories (refreshed_at, ts);"
