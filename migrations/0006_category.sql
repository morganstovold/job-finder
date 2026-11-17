-- EMT-B job ("emt") or firefighter trainee/recruit opening ("ff"), set by the filter.
ALTER TABLE jobs ADD COLUMN category TEXT NOT NULL DEFAULT 'emt';
ALTER TABLE announcements ADD COLUMN category TEXT NOT NULL DEFAULT 'emt';
