-- Reminders are now a configurable list (REMINDERS_MIN); repeats are prevented by their queue dedupe
-- keys, so the two fixed flags aren't needed.
ALTER TABLE announcements DROP COLUMN reminded_24h;
ALTER TABLE announcements DROP COLUMN reminded_1h;
