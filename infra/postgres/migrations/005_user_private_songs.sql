ALTER TABLE drive_tracks
ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

ALTER TABLE drive_tracks
ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'drive';

CREATE INDEX IF NOT EXISTS idx_drive_tracks_owner_synced
ON drive_tracks (owner_user_id, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_drive_tracks_source_type
ON drive_tracks (source_type);
