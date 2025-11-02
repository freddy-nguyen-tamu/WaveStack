CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS drive_tracks (
    id TEXT PRIMARY KEY,
    drive_file_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    artist_name TEXT NOT NULL DEFAULT '',
    album_title TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    stream_url TEXT NOT NULL DEFAULT '',
    genre_names TEXT[] NOT NULL DEFAULT '{}',
    score DOUBLE PRECISION,
    thumbnail_url TEXT,
    embedded_artwork_url TEXT,
    drive_thumbnail_url TEXT,
    local_thumbnail_url TEXT,
    lyrics TEXT,
    web_view_link TEXT,
    mime_type TEXT,
    modified_time TIMESTAMPTZ,
    size_bytes BIGINT,
    source_root_folder_id TEXT,
    normalized_search TEXT NOT NULL DEFAULT '',
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_drive_tracks_synced
ON drive_tracks (synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_drive_tracks_modified
ON drive_tracks (modified_time DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_drive_tracks_artist
ON drive_tracks (artist_name);

CREATE INDEX IF NOT EXISTS idx_drive_tracks_deleted
ON drive_tracks (deleted_at);

CREATE TABLE IF NOT EXISTS drive_track_sync_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    scanned_count INTEGER NOT NULL DEFAULT 0,
    upserted_count INTEGER NOT NULL DEFAULT 0,
    thumbnail_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
);
