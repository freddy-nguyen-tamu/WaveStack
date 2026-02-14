CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE app_listening_events
ADD COLUMN IF NOT EXISTS id UUID DEFAULT uuid_generate_v4();

UPDATE app_listening_events
SET id = uuid_generate_v4()
WHERE id IS NULL;

ALTER TABLE app_listening_events
ALTER COLUMN id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_listening_events_id_key
ON app_listening_events (id);

CREATE TABLE IF NOT EXISTS app_listening_event_archive_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    cutoff_at TIMESTAMPTZ NOT NULL,
    dry_run BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'running',
    exported_event_count INTEGER NOT NULL DEFAULT 0,
    deleted_event_count INTEGER NOT NULL DEFAULT 0,
    drive_file_count INTEGER NOT NULL DEFAULT 0,
    drive_folder_id TEXT,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_archive_runs_started_at
    ON app_listening_event_archive_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_archive_runs_user_started_at
    ON app_listening_event_archive_runs (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS app_listening_monthly_rollups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    month_start DATE NOT NULL,
    song_id TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    title TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 0,
    total_duration_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, month_start, song_id)
);

CREATE INDEX IF NOT EXISTS idx_monthly_rollups_user_month
    ON app_listening_monthly_rollups (user_id, month_start DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_rollups_user_artist
    ON app_listening_monthly_rollups (user_id, artist_name);

CREATE INDEX IF NOT EXISTS idx_monthly_rollups_user_song
    ON app_listening_monthly_rollups (user_id, song_id);

CREATE INDEX IF NOT EXISTS idx_listening_events_user_started
    ON app_listening_events (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_listening_events_started
    ON app_listening_events (started_at);
