-- Adds a lock flag so that once a track's title/artist has been repaired
-- from its embedded ID3/MP4/FLAC tags (instead of guessed from the Drive
-- filename), future library syncs will not overwrite it back to the
-- filename-derived guess.
ALTER TABLE drive_tracks
  ADD COLUMN IF NOT EXISTS title_locked boolean NOT NULL DEFAULT false;
