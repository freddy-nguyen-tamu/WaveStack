ALTER TABLE drive_tracks ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;

UPDATE drive_tracks SET first_seen_at = COALESCE(first_seen_at, synced_at, modified_time, now()) WHERE first_seen_at IS NULL;

ALTER TABLE drive_tracks ALTER COLUMN first_seen_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_drive_tracks_first_seen ON drive_tracks (first_seen_at DESC NULLS LAST);
