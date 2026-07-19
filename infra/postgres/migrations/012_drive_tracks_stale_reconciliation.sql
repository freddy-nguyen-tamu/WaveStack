ALTER TABLE IF EXISTS drive_track_sync_runs
ADD COLUMN IF NOT EXISTS deleted_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_drive_tracks_drive_root_active
ON drive_tracks (source_root_folder_id, id)
WHERE source_type = 'drive'
  AND owner_user_id IS NULL
  AND deleted_at IS NULL;
