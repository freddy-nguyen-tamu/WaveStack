import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DatabaseService } from "../database/database.service";
import { DriveSyncStatus, Song, SongConnection, UserSongAttributeInput, UserSongInput } from "./music.models";

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
  drive_created_time: Date | string | null;
  first_seen_at: Date | string | null;
  size_bytes: string | number | null;
  source_root_folder_id: string | null;
  owner_user_id: string | null;
  source_type: string | null;
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
          drive_created_time,
          first_seen_at,
          size_bytes,
          source_root_folder_id,
          normalized_search,
          synced_at,
          deleted_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, now(), $19, $20, $21, now(), NULL
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
          drive_created_time = COALESCE(EXCLUDED.drive_created_time, drive_tracks.drive_created_time),
          first_seen_at = COALESCE(drive_tracks.first_seen_at, EXCLUDED.first_seen_at, now()),
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
          song.createdTime ?? null,
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
    userId?: string | null;
    sort?: string | null;
  }): Promise<SongConnection> {
    const first = Math.max(1, Math.min(options.first || 50, 100));
    const offset = options.after ? Number(Buffer.from(options.after, "base64url").toString("utf8")) : 0;
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
    const search = options.query?.trim().toLowerCase();
    const sort = options.sort ?? "DATE_DESC";
    const orderBy =
      sort === "TITLE_ASC"
        ? "ORDER BY lower(title) ASC, lower(artist_name) ASC, id ASC"
        : sort === "ARTIST_ASC"
          ? "ORDER BY lower(artist_name) ASC, lower(title) ASC, id ASC"
          : sort === "DATE_ASC"
            ? "ORDER BY drive_created_time ASC NULLS LAST, modified_time ASC NULLS LAST, first_seen_at ASC NULLS LAST, synced_at ASC, id ASC"
            : "ORDER BY drive_created_time DESC NULLS LAST, modified_time DESC NULLS LAST, first_seen_at DESC NULLS LAST, synced_at DESC, id DESC";

    const params: unknown[] = [];
    const conditions = [
      "deleted_at IS NULL",
      options.userId ? "(owner_user_id IS NULL OR owner_user_id = $1::uuid)" : "owner_user_id IS NULL"
    ];

    if (options.userId) {
      params.push(options.userId);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`normalized_search ILIKE $${params.length}`);
    }

    params.push(first + 1);
    const limitParam = params.length;
    params.push(safeOffset);
    const offsetParam = params.length;
    const where = `WHERE ${conditions.join(" AND ")}`;

    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        ${where}
        ${orderBy}
        LIMIT $${limitParam}
        OFFSET $${offsetParam}
        `,
        params
      )
    ).rows;

    const countParams = params.slice(0, params.length - 2);
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

  async listDashboardSongsForUser(limit: number, userId?: string | null): Promise<Song[]> {
    const safeLimit = Math.max(8, Math.min(limit || 40, 80));
    const visibility = userId
      ? "(owner_user_id IS NULL OR owner_user_id = $2::uuid)"
      : "owner_user_id IS NULL";
    const params: unknown[] = userId ? [safeLimit, userId] : [safeLimit];

    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        WHERE deleted_at IS NULL
          AND ${visibility}
        ORDER BY random()
        LIMIT $1
        `,
        params
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

  async getSongForUser(id: string, userId?: string | null): Promise<Song | null> {
    const visibility = userId
      ? "(owner_user_id IS NULL OR owner_user_id = $2::uuid)"
      : "owner_user_id IS NULL";
    const params: unknown[] = userId ? [id, userId] : [id];

    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        WHERE id = $1
          AND deleted_at IS NULL
          AND ${visibility}
        LIMIT 1
        `,
        params
      )
    ).rows;

    return rows[0] ? this.rowToSong(rows[0]) : null;
  }

  async createUserSongs(userId: string, inputs: UserSongInput[]): Promise<Song[]> {
    const songs: Song[] = [];

    for (const input of inputs) {
      const song = this.inputToSong(userId, input);
      const search = this.normalizedSearch(song);

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
          lyrics,
          source_root_folder_id,
          owner_user_id,
          source_type,
          first_seen_at,
          normalized_search,
          synced_at,
          deleted_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, 'user', now(), $14, now(), NULL
        )
        `,
        [
          song.id,
          song.id,
          song.title,
          song.artistName,
          song.albumTitle,
          song.durationSeconds,
          song.streamUrl,
          song.genreNames,
          song.score ?? null,
          song.thumbnailUrl ?? null,
          song.lyrics ?? null,
          song.sourceRootFolderId ?? null,
          userId,
          search
        ]
      );

      songs.push(song);
    }

    return songs;
  }

  async updateUserSongAttributes(
    userId: string,
    songId: string,
    input: UserSongAttributeInput
  ): Promise<Song | null> {
    const current = await this.getOwnedUserSong(songId, userId);

    if (!current) {
      return null;
    }

    const next: Song = {
      ...current,
      title: this.clean(input.title, current.title),
      artistName: this.clean(input.artistName, current.artistName),
      albumTitle: this.clean(input.albumTitle, current.albumTitle),
      durationSeconds: input.durationSeconds ?? current.durationSeconds,
      streamUrl: this.clean(input.streamUrl, current.streamUrl),
      genreNames: input.genreNames?.map((genre) => genre.trim()).filter(Boolean) ?? current.genreNames,
      thumbnailUrl: this.clean(input.thumbnailUrl, current.thumbnailUrl),
      lyrics: input.lyrics ?? current.lyrics
    };

    await this.database.query(
      `
      UPDATE drive_tracks
      SET title = $3,
          artist_name = $4,
          album_title = $5,
          duration_seconds = $6,
          stream_url = $7,
          genre_names = $8,
          thumbnail_url = $9,
          lyrics = $10,
          normalized_search = $11,
          synced_at = now()
      WHERE id = $1
        AND owner_user_id = $2::uuid
        AND source_type = 'user'
      `,
      [
        songId,
        userId,
        next.title,
        next.artistName,
        next.albumTitle,
        next.durationSeconds,
        next.streamUrl,
        next.genreNames,
        next.thumbnailUrl ?? null,
        next.lyrics ?? null,
        this.normalizedSearch(next)
      ]
    );

    return this.getSongForUser(songId, userId);
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
      createdTime: this.dateToString(row.drive_created_time),
      addedAt: this.dateToString(row.drive_created_time ?? row.modified_time ?? row.first_seen_at),
      sizeBytes: row.size_bytes ? Number(row.size_bytes) : undefined,
      sourceRootFolderId: row.source_root_folder_id ?? undefined
    };
  }

  private async getOwnedUserSong(songId: string, userId: string): Promise<Song | null> {
    const rows = (
      await this.database.query<DriveTrackRow>(
        `
        SELECT *
        FROM drive_tracks
        WHERE id = $1
          AND owner_user_id = $2::uuid
          AND source_type = 'user'
          AND deleted_at IS NULL
        LIMIT 1
        `,
        [songId, userId]
      )
    ).rows;

    return rows[0] ? this.rowToSong(rows[0]) : null;
  }

  private inputToSong(userId: string, input: UserSongInput): Song {
    const title = this.clean(input.title, "Untitled song");
    const artistName = this.clean(input.artistName, "Unknown Artist");
    const albumTitle = this.clean(input.albumTitle, "User additions");
    const genreNames = input.genreNames?.map((genre) => genre.trim()).filter(Boolean) ?? [];
    const id = `user-${userId}-${randomUUID()}`;

    return {
      id,
      title,
      artistName,
      albumTitle,
      durationSeconds: Math.max(0, Math.round(input.durationSeconds ?? 0)),
      streamUrl: this.clean(input.streamUrl, ""),
      genreNames,
      score: 1,
      thumbnailUrl: this.clean(input.thumbnailUrl, undefined),
      lyrics: input.lyrics?.trim() || undefined,
      sourceRootFolderId: "user-private-library"
    };
  }

  private normalizedSearch(song: Song): string {
    return [
      song.title,
      song.artistName,
      song.albumTitle,
      ...(song.genreNames ?? [])
    ]
      .join(" ")
      .toLowerCase();
  }

  private clean(value: string | null | undefined, fallback: string): string;
  private clean(value: string | null | undefined, fallback: string | undefined): string | undefined;
  private clean(value: string | null | undefined, fallback: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed || fallback;
  }

  private dateToString(value: Date | string | null): string | undefined {
    if (!value) return undefined;
    return value instanceof Date ? value.toISOString() : String(value);
  }
}
