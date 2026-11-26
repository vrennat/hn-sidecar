-- A failed Firebase item remains discoverable even after it leaves the live feeds.
CREATE TABLE IF NOT EXISTS item_retries (
  id INTEGER PRIMARY KEY,
  retry_after INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS item_retries_due ON item_retries (retry_after);
