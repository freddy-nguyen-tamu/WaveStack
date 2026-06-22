CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS app_user_drive_archive_roots (
    user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    root_folder_id TEXT NOT NULL,
    root_folder_name TEXT NOT NULL DEFAULT 'Listening_habits',
    root_folder_web_view_link TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_listening_archive_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    archive_date DATE NOT NULL,
    archive_year INTEGER NOT NULL,
    archive_month INTEGER NOT NULL,
    drive_file_id TEXT NOT NULL,
    drive_folder_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/x-ndjson',
    event_count INTEGER NOT NULL DEFAULT 0,
    byte_size INTEGER,
    web_view_link TEXT,
    exported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cached_at TIMESTAMPTZ,
    last_read_at TIMESTAMPTZ,
    cache_status TEXT NOT NULL DEFAULT 'not_cached',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, archive_date),
    UNIQUE (drive_file_id)
);

CREATE INDEX IF NOT EXISTS idx_archive_files_user_date
    ON app_listening_archive_files (user_id, archive_date DESC);

CREATE INDEX IF NOT EXISTS idx_archive_files_user_cache_status
    ON app_listening_archive_files (user_id, cache_status, archive_date DESC);

CREATE TABLE IF NOT EXISTS app_listening_archive_cached_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    archive_file_id UUID NOT NULL REFERENCES app_listening_archive_files(id) ON DELETE CASCADE,
    original_event_id UUID,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    title TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    completed_play_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, original_event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_listening_archive_cached_events_fallback_uidx
    ON app_listening_archive_cached_events (user_id, song_id, started_at)
    WHERE original_event_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_archive_cached_events_user_started
    ON app_listening_archive_cached_events (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_archive_cached_events_user_song
    ON app_listening_archive_cached_events (user_id, song_id);

CREATE INDEX IF NOT EXISTS idx_archive_cached_events_user_artist
    ON app_listening_archive_cached_events (user_id, artist_name);

CREATE OR REPLACE VIEW app_listening_events_combined AS
SELECT
    id::text AS combined_event_id,
    id AS original_event_id,
    user_id,
    song_id,
    artist_name,
    title,
    duration_seconds,
    completed_play_ratio,
    started_at,
    created_at,
    'hot'::text AS storage_source
FROM app_listening_events

UNION ALL

SELECT
    ce.id::text AS combined_event_id,
    ce.original_event_id,
    ce.user_id,
    ce.song_id,
    ce.artist_name,
    ce.title,
    ce.duration_seconds,
    ce.completed_play_ratio,
    ce.started_at,
    ce.cached_at AS created_at,
    'cold_cache'::text AS storage_source
FROM app_listening_archive_cached_events ce
WHERE NOT EXISTS (
    SELECT 1
    FROM app_listening_events e
    WHERE e.id = ce.original_event_id
);
