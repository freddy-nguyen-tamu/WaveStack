CREATE TABLE IF NOT EXISTS app_stats_snapshots (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_stats_snapshot_entries (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES app_stats_snapshots(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  position INT NOT NULL,
  song_id TEXT,
  artist_name TEXT NOT NULL DEFAULT '',
  play_count INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_snapshot_entries_snapshot_id ON app_stats_snapshot_entries(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_entries_category ON app_stats_snapshot_entries(snapshot_id, category);
