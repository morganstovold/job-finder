-- Exponential backoff per board: consecutive failures and when to try again.
ALTER TABLE source_status ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_status ADD COLUMN next_attempt INTEGER;
