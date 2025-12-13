import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { DriveSyncStatus, Song, SongConnection } from "./music.models";

type DriveTrackRow = {
  id: string;
  drive_file_id: string;
  title: string;
  artist_name: string;
  album_title: string;
  duration_seconds: number;
  stream_url: string;
  genre_names: string[];
  score: number | null;
  thumbnail_url: string | null;
  local_thumbnail_url: string | null;
  drive_thumbnail_url: string | null;
  embedded_artwork_url: string | null;
  lyrics: string | null;
  web_view_link: string | null;
  mime_type: string | null;
  modified_time: Date | string | null;
  size_bytes: string | number | null;
  source_root_folder_id: string | null;
};

type CountRow = {
  count: string;
};

type SyncStatusRow = {
  status: string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  scanned_count: number;
  upserted_count: number;
  thumbnail_count: number;
  error_message: string | null;
};

@Injectable()
export class DriveTrackRepository {
  constructor(private readonly database: DatabaseService) {}

  async upsertTracks(songs: Song[]): Promise<number> {
    let count = 0;

    for (const song of songs) {
      const search = [
        song.title,
        song.artistName,
        song.albumTitle,
        ...(song.genreNames ?? [])
      ]
        .join(" ")
        .toLowerCase();

      await this.database.query(
        `
        INSERT INTO drive_tracks (
          id,
          drive_file_id,
          title,
          artist_name,
          album_title,
          duration_seconds,
          stream_url,
          genre_names,
          score,
          thumbnail_url,
          local_thumbnail_url,
          drive_thumbnail_url,
          embedded_artwork_url,
          lyrics,
          web_view_link,
          mime_type,
          modified_time,
          size_bytes,
          source_root_folder_id,
          normalized_search,
          synced_at,
          deleted_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, now(), NULL
        )
        ON CONFLICT (id)
        DO UPDATE SET
          drive_file_id = EXCLUDED.drive_file_id,
          title = EXCLUDED.title,
          artist_name = EXCLUDED.artist_name,
          album_title = EXCLUDED.album_title,
          duration_seconds = EXCLUDED.duration_seconds,
          stream_url = EXCLUDED.stream_url,
          genre_names = EXCLUDED.genre_names,
          score = EXCLUDED.score,
          thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, drive_tracks.thumbnail_url),
          local_thumbnail_url = COALESCE(EXCLUDED.local_thumbnail_url, drive_tracks.local_thumbnail_url),
          drive_thumbnail_url = COALESCE(EXCLUDED.drive_thumbnail_url, drive_tracks.drive_thumbnail_url),
          embedded_artwork_url = COALESCE(EXCLUDED.embedded_artwork_url, drive_tracks.embedded_artwork_url),
          lyrics = COALESCE(EXCLUDED.lyrics, drive_tracks.lyrics),
          web_view_link = EXCLUDED.web_view_link,
          mime_type = EXCLUDED.mime_type,
          modified_time = EXCLUDED.modified_time,
          size_bytes = EXCLUDED.size_bytes,
          source_root_folder_id = EXCLUDED.source_root_folder_id,
          normalized_search = EXCLUDED.normalized_search,
          synced_at = now(),
          deleted_at = NULL
        `,
        [
          song.id,
          song.id.replace(/^drive-/, ""),
          song.title,
          song.artistName,
          song.albumTitle,
          song.durationSeconds ?? 0,
          song.streamUrl,
          song.genreNames ?? [],
          song.score ?? null,
          song.localThumbnailUrl ?? song.thumbnailUrl ?? song.driveThumbnailUrl ?? null,
          song.localThumbnailUrl ?? null,
          song.driveThumbnailUrl ?? null,
          song.embeddedArtworkUrl ?? null,
          song.lyrics ?? null,
          song.webViewLink ?? null,
          song.mimeType ?? null,
          song.modifiedTime ?? null,
          song.sizeBytes ?? null,
          song.sourceRootFolderId ?? null,
          search
        ]
      );

      count += 1;
    }

    return count;
  }

  async updateLyrics(trackId: string, lyrics: string): Promise<void> {
    await this.database.query(
      `
      UPDATE drive_tracks
      SET lyrics = $2
      WHERE id = $1
      `,
      [trackId, lyrics]
    );
  }

  async listTracksMissingLyrics(limit: number): Promise<Song[]> {
    const safeLimit = Math.max(1, Math.min(limit || 10, 25));

    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        WHERE deleted_at IS NULL
          AND (lyrics IS NULL OR length(trim(lyrics)) = 0)
        ORDER BY synced_at DESC, id ASC
        LIMIT $1
        `,
        [safeLimit]
      )
    ).rows;

    return rows.map((row) => this.rowToSong(row));
  }

  async updateLocalThumbnail(trackId: string, localThumbnailUrl: string): Promise<void> {
    await this.database.query(
      `
      UPDATE drive_tracks
      SET local_thumbnail_url = $2,
          thumbnail_url = $2
      WHERE id = $1
      `,
      [trackId, localThumbnailUrl]
    );
  }

  async listSongs(options: {
    first: number;
    after?: string | null;
    query?: string | null;
  }): Promise<SongConnection> {
    const first = Math.max(1, Math.min(options.first || 50, 100));
    const offset = options.after ? Number(Buffer.from(options.after, "base64url").toString("utf8")) : 0;
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
    const search = options.query?.trim().toLowerCase();

    const where = search
      ? `WHERE deleted_at IS NULL AND normalized_search ILIKE $1`
      : `WHERE deleted_at IS NULL`;

    const params: unknown[] = search ? [`%${search}%`, first + 1, safeOffset] : [first + 1, safeOffset];
    const limitParam = search ? 2 : 1;
    const offsetParam = search ? 3 : 2;

    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        ${where}
        ORDER BY synced_at DESC, id ASC
        LIMIT $${limitParam}
        OFFSET $${offsetParam}
        `,
        params
      )
    ).rows;

    const countParams: unknown[] = search ? [`%${search}%`] : [];
    const countRows = (
      await this.database.query<CountRow>(
        `
        SELECT COUNT(*)::text AS count
        FROM drive_tracks
        ${where}
        `,
        countParams
      )
    ).rows;

    const hasNextPage = rows.length > first;
    const pageRows = rows.slice(0, first);
    const nextOffset = safeOffset + pageRows.length;

    return {
      nodes: pageRows.map((row) => this.rowToSong(row)),
      pageInfo: {
        hasNextPage,
        endCursor: hasNextPage ? Buffer.from(String(nextOffset), "utf8").toString("base64url") : undefined
      },
      totalCount: Number(countRows[0]?.count ?? 0)
    };
  }

  async listDashboardSongs(limit: number): Promise<Song[]> {
    const safeLimit = Math.max(8, Math.min(limit || 40, 80));

    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        WHERE deleted_at IS NULL
        ORDER BY random()
        LIMIT $1
        `,
        [safeLimit]
      )
    ).rows;

    return rows.map((row) => this.rowToSong(row));
  }

  async getSong(id: string): Promise<Song | null> {
    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1
        `,
        [id]
      )
    ).rows;

    return rows[0] ? this.rowToSong(rows[0]) : null;
  }

  async countTracks(): Promise<number> {
    const rows = (
      await this.database.query<CountRow>(
        `
        SELECT COUNT(*)::text AS count
        FROM drive_tracks
        WHERE deleted_at IS NULL
        `
      )
    ).rows;

    return Number(rows[0]?.count ?? 0);
  }

  async listTracksMissingLocalThumbnails(limit: number): Promise<Song[]> {
    const safeLimit = Math.max(1, Math.min(limit || 10, 25));

    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        WHERE deleted_at IS NULL
          AND local_thumbnail_url IS NULL
        ORDER BY synced_at DESC, id ASC
        LIMIT $1
        `,
        [safeLimit]
      )
    ).rows;

    return rows.map((row) => this.rowToSong(row));
  }

  async createSyncRun(): Promise<string> {
    const rows = (
      await this.database.query<{ id: string }>(
        `
        INSERT INTO drive_track_sync_runs (status)
        VALUES ('running')
        RETURNING id
        `
      )
    ).rows;

    return rows[0].id;
  }

  async finishSyncRun(id: string, input: {
    status: "success" | "failed";
    scannedCount: number;
    upsertedCount: number;
    thumbnailCount: number;
    errorMessage?: string;
  }): Promise<void> {
    await this.database.query(
      `
      UPDATE drive_track_sync_runs
      SET status = $2,
          finished_at = now(),
          scanned_count = $3,
          upserted_count = $4,
          thumbnail_count = $5,
          error_message = $6
      WHERE id = $1
      `,
      [
        id,
        input.status,
        input.scannedCount,
        input.upsertedCount,
        input.thumbnailCount,
        input.errorMessage ?? null
      ]
    );
  }

  async latestSyncStatus(): Promise<DriveSyncStatus> {
    const rows = (
      await this.database.query<SyncStatusRow>(
        `
        SELECT status, started_at, finished_at, scanned_count, upserted_count, thumbnail_count, error_message
        FROM drive_track_sync_runs
        ORDER BY started_at DESC
        LIMIT 1
        `
      )
    ).rows;

    const row = rows[0];

    if (!row) {
      return {
        status: "never",
        scannedCount: 0,
        upsertedCount: 0,
        thumbnailCount: 0
      };
    }

    return {
      status: row.status,
      startedAt: this.dateToString(row.started_at),
      finishedAt: this.dateToString(row.finished_at),
      scannedCount: row.scanned_count,
      upsertedCount: row.upserted_count,
      thumbnailCount: row.thumbnail_count,
      errorMessage: row.error_message ?? undefined
    };
  }

  private rowToSong(row: DriveTrackRow): Song {
    return {
      id: row.id,
      title: row.title,
      artistName: row.artist_name,
      albumTitle: row.album_title,
      durationSeconds: Number(row.duration_seconds ?? 0),
      streamUrl: row.stream_url,
      genreNames: row.genre_names ?? [],
      score: row.score ?? undefined,
      thumbnailUrl: row.local_thumbnail_url ?? row.thumbnail_url ?? row.drive_thumbnail_url ?? undefined,
      localThumbnailUrl: row.local_thumbnail_url ?? undefined,
      driveThumbnailUrl: row.drive_thumbnail_url ?? undefined,
      embeddedArtworkUrl: row.embedded_artwork_url ?? undefined,
      lyrics: row.lyrics ?? undefined,
      webViewLink: row.web_view_link ?? undefined,
      mimeType: row.mime_type ?? undefined,
      modifiedTime: this.dateToString(row.modified_time),
      sizeBytes: row.size_bytes ? Number(row.size_bytes) : undefined,
      sourceRootFolderId: row.source_root_folder_id ?? undefined
    };
  }

  private dateToString(value: Date | string | null): string | undefined {
    if (!value) return undefined;
    return value instanceof Date ? value.toISOString() : String(value);
  }
}
