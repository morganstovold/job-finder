-- Announcement emails ("applications open 11/16 at 12:01 AM") being watched until the posting appears.
CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  announcer     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  open_at       INTEGER,            -- NULL = date not stated
  reminded_24h  INTEGER NOT NULL DEFAULT 0,
  reminded_1h   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'watching',  -- watching | confirmed | expired
  job_id        TEXT                 -- the posting that confirmed it
);
CREATE INDEX IF NOT EXISTS announcements_status ON announcements (status);
