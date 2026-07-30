-- D1 is the build-time authority: raw URLs live here and nowhere else,
-- because shards store hashes and a NORM_VERSION rebuild must re-normalize from raw.
-- Never queried at read time.

CREATE TABLE IF NOT EXISTS stories (
  id           INTEGER PRIMARY KEY,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  by           TEXT NOT NULL,
  score        INTEGER NOT NULL,
  descendants  INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL DEFAULT 0
);

-- Stories touched in the last 48 h; ingest queries by ts.
CREATE INDEX IF NOT EXISTS stories_ts ON stories (ts);

-- Rolling re-fetch: the K stalest rows.
CREATE INDEX IF NOT EXISTS stories_refreshed_at ON stories (refreshed_at, ts);

-- One row per (story, variant hash). Ingest writes these; the regen batch reads
-- them by bucket. `bucket` is the high 14 bits of the digest (see packages/shared).
CREATE TABLE IF NOT EXISTS story_hashes (
  story_id   INTEGER NOT NULL,
  h          TEXT NOT NULL,
  bucket     INTEGER NOT NULL,
  PRIMARY KEY (story_id, h)
);

-- The regen batch's only access pattern: every hash in one bucket.
CREATE INDEX IF NOT EXISTS story_hashes_bucket ON story_hashes (bucket);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
