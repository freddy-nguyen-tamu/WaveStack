INSERT INTO users (email, display_name, password_hash)
VALUES ('demo@wavestack.local', 'WaveStack Listener', 'replace-with-argon2-hash')
ON CONFLICT (email) DO NOTHING;

INSERT INTO artists (name, bio)
VALUES
    ('The Latency', 'Electronic music for cloud dashboards.'),
    ('Blue Queue', 'Async pop from the message bus.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO genres (name)
VALUES ('electronic'), ('ambient'), ('indie'), ('pop')
ON CONFLICT (name) DO NOTHING;
