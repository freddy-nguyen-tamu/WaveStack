ALTER TABLE drive_tracks ADD COLUMN IF NOT EXISTS drive_created_time TIMESTAMPTZ;

UPDATE drive_tracks
SET drive_created_time = COALESCE(drive_created_time, modified_time, first_seen_at, synced_at)
WHERE drive_created_time IS NULL;

CREATE INDEX IF NOT EXISTS idx_drive_tracks_drive_created_time
ON drive_tracks (drive_created_time DESC NULLS LAST);
