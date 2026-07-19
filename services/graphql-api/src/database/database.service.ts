import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, QueryResult, QueryResultRow } from "pg";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor(private readonly config: ConfigService) {
    this.pool = new Pool({
      host: this.config.get<string>("POSTGRES_HOST") ?? "localhost",
      port: Number(this.config.get<string>("POSTGRES_PORT") ?? 5432),
      database: this.config.get<string>("POSTGRES_DB") ?? "wavestack",
      user: this.config.get<string>("POSTGRES_USER") ?? "wavestack",
      password: this.config.get<string>("POSTGRES_PASSWORD") ?? "wavestack_dev_password"
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureUserLibraryTables();
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  private async ensureUserLibraryTables(): Promise<void> {
    await this.pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await this.pool.query(`
      ALTER TABLE IF EXISTS drive_tracks
      ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES app_users(id) ON DELETE CASCADE
    `);

    await this.pool.query(`
      ALTER TABLE IF EXISTS drive_tracks
      ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'drive'
    `);

    await this.pool.query(`
      ALTER TABLE IF EXISTS drive_track_sync_runs
      ADD COLUMN IF NOT EXISTS deleted_count INTEGER NOT NULL DEFAULT 0
    `);

    await this.pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'drive_tracks'
        ) THEN
          CREATE INDEX IF NOT EXISTS idx_drive_tracks_owner_synced
          ON drive_tracks (owner_user_id, synced_at DESC);

          CREATE INDEX IF NOT EXISTS idx_drive_tracks_source_type
          ON drive_tracks (source_type);

          CREATE INDEX IF NOT EXISTS idx_drive_tracks_drive_root_active
          ON drive_tracks (source_root_folder_id, id)
          WHERE source_type = 'drive'
            AND owner_user_id IS NULL
            AND deleted_at IS NULL;
        END IF;
      END $$;
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_favorites (
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        song_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, song_id)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_app_favorites_user_created
      ON app_favorites (user_id, created_at DESC)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_user_playlists (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_app_user_playlists_user_updated
      ON app_user_playlists (user_id, updated_at DESC)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_user_playlist_songs (
        playlist_id UUID NOT NULL REFERENCES app_user_playlists(id) ON DELETE CASCADE,
        song_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (playlist_id, song_id)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_app_user_playlist_songs_playlist_position
      ON app_user_playlist_songs (playlist_id, position ASC, added_at ASC)
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_app_user_playlist_songs_song
      ON app_user_playlist_songs (song_id)
    `);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
