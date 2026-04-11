CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS app_favorites (
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, song_id)
);

CREATE INDEX IF NOT EXISTS idx_app_favorites_user_created
    ON app_favorites (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_user_playlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_user_playlists_user_updated
    ON app_user_playlists (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_user_playlist_songs (
    playlist_id UUID NOT NULL REFERENCES app_user_playlists(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (playlist_id, song_id)
);

CREATE INDEX IF NOT EXISTS idx_app_user_playlist_songs_playlist_position
    ON app_user_playlist_songs (playlist_id, position ASC, added_at ASC);

CREATE INDEX IF NOT EXISTS idx_app_user_playlist_songs_song
    ON app_user_playlist_songs (song_id);
