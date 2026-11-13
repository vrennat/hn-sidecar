-- Replace story_hashes_bucket (bucket, story_id) with a covering (bucket, story_id, h).
--
-- The ingest shard rewrite selects h by bucket, ordered by (story_id, h). Without h
-- in the index, every match costs an extra table-row read plus a temp sort. Measured
-- read-only on production 2026-11-12 for bucket 4242 (42 rows): 127 rows read with
-- the current index, 85 for a join reshaped to stay inside it (an estimate of the
-- new index, not a measurement of it).
--
-- Create before drop so the bucket lookups never lose their index. Safe to apply
-- before or after the matching Worker deploy: no code names the index.
--
-- Apply with --command (query API); --file uses the import API, which has failed
-- intermittently under wrangler OAuth. Both statements are idempotent, so a retry
-- or partial run is safe:
--   wrangler d1 execute hn-sidecar --remote --command "CREATE INDEX IF NOT EXISTS story_hashes_bucket_h ON story_hashes (bucket, story_id, h); DROP INDEX IF EXISTS story_hashes_bucket;"
CREATE INDEX IF NOT EXISTS story_hashes_bucket_h ON story_hashes (bucket, story_id, h);
DROP INDEX IF EXISTS story_hashes_bucket;
