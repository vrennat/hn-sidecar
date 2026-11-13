-- Replace story_hashes_bucket (bucket, story_id) with a covering (bucket, story_id, h).
--
-- The ingest shard rewrite selects h by bucket, ordered by (story_id, h). Without h
-- in the index, every match costs an extra table-row read plus a temp sort. Measured
-- read-only on production 2026-11-12 for bucket 4242 (42 rows): 127 rows read with
-- the current index, 85 for the same join shaped to stay inside the index.
--
-- Create before drop so the bucket lookups never lose their index. Safe to apply
-- before or after the matching Worker deploy: no code names the index.
--
--   wrangler d1 execute hn-sidecar --remote --file=db/migrations/2026-11-12-story-hashes-bucket-covering.sql
CREATE INDEX IF NOT EXISTS story_hashes_bucket_h ON story_hashes (bucket, story_id, h);
DROP INDEX IF EXISTS story_hashes_bucket;
