CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS app_user_drive_archive_roots (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  root_folder_id text NOT NULL,
  root_folder_name text NOT NULL DEFAULT 'Listening_habits',
  root_folder_web_view_link text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_listening_archive_files (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  archive_date date NOT NULL,
  archive_year int NOT NULL,
  archive_month int NOT NULL,
  drive_file_id text,
  drive_folder_id text,
  file_name text NOT NULL,
  event_count int NOT NULL DEFAULT 0,
  web_view_link text,
  cache_status text NOT NULL DEFAULT 'not_cached',
  exported_at timestamptz,
  cached_at timestamptz,
  last_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, archive_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_listening_archive_files_drive_file_id_uidx
  ON app_listening_archive_files(drive_file_id)
  WHERE drive_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS app_listening_archive_files_user_date_idx
  ON app_listening_archive_files(user_id, archive_date DESC);

CREATE TABLE IF NOT EXISTS app_listening_archive_cached_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  archive_file_id uuid NOT NULL REFERENCES app_listening_archive_files(id) ON DELETE CASCADE,
  original_event_id uuid,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  song_id text NOT NULL,
  artist_name text NOT NULL DEFAULT 'Unknown Artist',
  title text NOT NULL DEFAULT 'Unknown Track',
  duration_seconds int NOT NULL DEFAULT 0,
  completed_play_ratio double precision NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  cached_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_listening_archive_cached_events_original_uidx
  ON app_listening_archive_cached_events(user_id, original_event_id)
  WHERE original_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_listening_archive_cached_events_fallback_uidx
  ON app_listening_archive_cached_events(user_id, song_id, started_at)
  WHERE original_event_id IS NULL;

CREATE INDEX IF NOT EXISTS app_listening_archive_cached_events_user_started_idx
  ON app_listening_archive_cached_events(user_id, started_at DESC);

DROP VIEW IF EXISTS app_listening_events_combined;

CREATE VIEW app_listening_events_combined AS
SELECT
  e.id::text AS combined_event_id,
  e.id AS original_event_id,
  e.user_id,
  e.song_id,
  e.artist_name,
  e.title,
  e.duration_seconds,
  e.completed_play_ratio,
  e.started_at,
  e.started_at AS created_at,
  'hot'::text AS storage_source
FROM app_listening_events e

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
WHERE ce.original_event_id IS NULL
   OR NOT EXISTS (
    SELECT 1
    FROM app_listening_events e
    WHERE e.id = ce.original_event_id
  );
