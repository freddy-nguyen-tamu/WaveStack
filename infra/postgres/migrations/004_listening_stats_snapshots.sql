CREATE TABLE IF NOT EXISTS listening_stat_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stat_type VARCHAR(32) NOT NULL,
  period VARCHAR(16) NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listening_stat_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  snapshot_id UUID NOT NULL REFERENCES listening_stat_snapshots(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  subtitle TEXT,
  rank INT NOT NULL,
  previous_rank INT NOT NULL DEFAULT 0,
  rank_change INT NOT NULL DEFAULT 0,
  play_count INT NOT NULL DEFAULT 0,
  total_duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  song_id TEXT,
  thumbnail_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_stat_entries_snapshot_id ON listening_stat_entries(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_stat_entries_snapshot_rank ON listening_stat_entries(snapshot_id, rank);
CREATE INDEX IF NOT EXISTS idx_stat_snapshots_type_period ON listening_stat_snapshots(stat_type, period, generated_at);
