-- A failed Firebase item remains discoverable even after it leaves the live feeds.
CREATE TABLE IF NOT EXISTS item_retries (
  id INTEGER PRIMARY KEY,
  retry_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS item_retries_due ON item_retries (attempts, retry_after DESC, id DESC);

-- Written in the same transaction as the story and hash rows they describe.
CREATE TABLE IF NOT EXISTS dirty_shards (
  bucket TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
