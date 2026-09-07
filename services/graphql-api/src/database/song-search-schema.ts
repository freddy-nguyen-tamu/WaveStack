export const SONG_SEARCH_SCHEMA = `
ALTER TABLE drive_tracks ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE drive_tracks ADD COLUMN IF NOT EXISTS legacy_search TEXT;

-- Retain filename aliases from older imports until their next Drive sync.
UPDATE drive_tracks SET legacy_search = normalized_search WHERE legacy_search IS NULL;

CREATE OR REPLACE FUNCTION refresh_drive_track_search() RETURNS trigger AS $$
BEGIN
  NEW.legacy_search := coalesce(NEW.legacy_search, '');
  NEW.normalized_search := lower(concat_ws(' ', NEW.file_name,
    CASE WHEN NEW.file_name IS NULL THEN NEW.legacy_search ELSE NULL END,
    NEW.title, NEW.artist_name, NEW.album_title, array_to_string(NEW.genre_names, ' ')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER drive_track_search_fields
BEFORE INSERT OR UPDATE ON drive_tracks
FOR EACH ROW EXECUTE FUNCTION refresh_drive_track_search();

UPDATE drive_tracks SET normalized_search = lower(concat_ws(' ', file_name,
  CASE WHEN file_name IS NULL THEN legacy_search ELSE NULL END,
  title, artist_name, album_title, array_to_string(genre_names, ' ')))
WHERE normalized_search IS DISTINCT FROM lower(concat_ws(' ', file_name,
  CASE WHEN file_name IS NULL THEN legacy_search ELSE NULL END,
  title, artist_name, album_title, array_to_string(genre_names, ' ')));

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_drive_tracks_search_trgm
ON drive_tracks USING gin (normalized_search gin_trgm_ops) WHERE deleted_at IS NULL;
`;
