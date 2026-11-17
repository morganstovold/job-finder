-- Notification Queue idempotency: queues deliver at least once, so each alert's dedupe key is
-- recorded here before the message is acked, and keys already present are skipped.
CREATE TABLE IF NOT EXISTS sent (
  key      TEXT PRIMARY KEY,
  sent_at  INTEGER NOT NULL
);
