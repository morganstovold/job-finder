-- Every EMT job that has ever matched. A job is "new" (and alerted) the first time its id shows up.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  title       TEXT NOT NULL,
  employer    TEXT NOT NULL,
  location    TEXT NOT NULL,
  url         TEXT NOT NULL,
  posted_at   TEXT,
  detail      TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs (first_seen DESC);

-- Health of each board so a silently broken scraper gets noticed.
CREATE TABLE IF NOT EXISTS source_status (
  source        TEXT PRIMARY KEY,
  last_ok       INTEGER,
  last_count    INTEGER,
  last_error    TEXT,
  last_error_at INTEGER,
  alerted       INTEGER NOT NULL DEFAULT 0
);
