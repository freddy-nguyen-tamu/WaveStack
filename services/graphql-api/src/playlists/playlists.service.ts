import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { GoogleDriveService } from "../music/google-drive.service";
import { Song } from "../music/music.models";
import { LibraryState, UserPlaylist } from "./playlists.models";

type FavoriteRow = {
  song_id: string;
};

type PlaylistRow = {
  id: string;
  name: string;
  song_count: string | number;
  song_ids: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
};

@Injectable()
export class PlaylistsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly googleDriveService: GoogleDriveService
  ) {}

  async getLibraryState(userId: string, recentLimit = 100): Promise<LibraryState> {
    const [favorites, playlists, recentlyPlayed] = await Promise.all([
      this.getFavoriteSongs(userId),
      this.getPlaylists(userId),
      this.getRecentlyPlayedSongs(userId, recentLimit)
    ]);

    return { favorites, playlists, recentlyPlayed };
  }

  async getFavoriteSongs(userId: string): Promise<Song[]> {
    const result = await this.database.query(
      `SELECT song_id
       FROM app_favorites
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    const ids = this.rows<FavoriteRow>(result).map((row) => row.song_id);
    return this.songsByIds(ids);
  }

  async toggleFavorite(userId: string, songId: string): Promise<Song[]> {
    const existing = await this.database.query(
      `SELECT 1
       FROM app_favorites
       WHERE user_id = $1
         AND song_id = $2
       LIMIT 1`,
      [userId, songId]
    );

    if (this.rows(existing).length) {
      await this.database.query(
        `DELETE FROM app_favorites
         WHERE user_id = $1 AND song_id = $2`,
        [userId, songId]
      );
    } else {
      await this.database.query(
        `INSERT INTO app_favorites (user_id, song_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, song_id) DO NOTHING`,
        [userId, songId]
      );
    }

    return this.getFavoriteSongs(userId);
  }

  async favoriteSong(userId: string, songId: string): Promise<Song[]> {
    await this.database.query(
      `INSERT INTO app_favorites (user_id, song_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, song_id) DO NOTHING`,
      [userId, songId]
    );

    return this.getFavoriteSongs(userId);
  }

  async unfavoriteSong(userId: string, songId: string): Promise<Song[]> {
    await this.database.query(
      `DELETE FROM app_favorites
       WHERE user_id = $1 AND song_id = $2`,
      [userId, songId]
    );

    return this.getFavoriteSongs(userId);
  }

  async getPlaylists(userId: string): Promise<UserPlaylist[]> {
    const result = await this.database.query(
      `SELECT
         p.id,
         p.name,
         p.created_at,
         p.updated_at,
         COUNT(ps.song_id)::int AS song_count,
         COALESCE(
           ARRAY_AGG(ps.song_id ORDER BY ps.position ASC, ps.added_at ASC)
             FILTER (WHERE ps.song_id IS NOT NULL),
           ARRAY[]::text[]
         ) AS song_ids
       FROM app_user_playlists p
       LEFT JOIN app_user_playlist_songs ps ON ps.playlist_id = p.id
       WHERE p.user_id = $1
       GROUP BY p.id
       ORDER BY p.updated_at DESC, p.created_at DESC`,
      [userId]
    );

    const rows = this.rows<PlaylistRow>(result);

    return Promise.all(
      rows.map(async (row) => {
        const songIds = row.song_ids ?? [];
        const songs = await this.songsByIds(songIds);

        return {
          id: row.id,
          name: row.name,
          songCount: Number(row.song_count ?? songIds.length),
          songIds,
          songs,
          createdAt: this.iso(row.created_at),
          updatedAt: this.iso(row.updated_at)
        };
      })
    );
  }

  async createPlaylist(userId: string, name: string): Promise<UserPlaylist[]> {
    const trimmed = name.trim();

    if (!trimmed) {
      return this.getPlaylists(userId);
    }

    await this.database.query(
      `INSERT INTO app_user_playlists (user_id, name)
       VALUES ($1, $2)`,
      [userId, trimmed]
    );

    return this.getPlaylists(userId);
  }

  async deletePlaylist(userId: string, playlistId: string): Promise<UserPlaylist[]> {
    await this.database.query(
      `DELETE FROM app_user_playlists
       WHERE id = $1 AND user_id = $2`,
      [playlistId, userId]
    );

    return this.getPlaylists(userId);
  }

  async addSongToPlaylist(userId: string, playlistId: string, songId: string): Promise<UserPlaylist[]> {
    const ownsPlaylist = await this.database.query(
      `SELECT id
       FROM app_user_playlists
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [playlistId, userId]
    );

    if (!this.rows(ownsPlaylist).length) {
      return this.getPlaylists(userId);
    }

    const positionResult = await this.database.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
       FROM app_user_playlist_songs
       WHERE playlist_id = $1`,
      [playlistId]
    );

    const nextPosition = Number(
      this.rows<{ next_position: string | number }>(positionResult)[0]?.next_position ?? 0
    );

    await this.database.query(
      `INSERT INTO app_user_playlist_songs (playlist_id, song_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (playlist_id, song_id) DO NOTHING`,
      [playlistId, songId, nextPosition]
    );

    await this.touchPlaylist(playlistId, userId);

    return this.getPlaylists(userId);
  }

  async removeSongFromPlaylist(userId: string, playlistId: string, songId: string): Promise<UserPlaylist[]> {
    await this.database.query(
      `DELETE FROM app_user_playlist_songs
       WHERE playlist_id = $1
         AND song_id = $2
         AND EXISTS (
           SELECT 1 FROM app_user_playlists p
           WHERE p.id = app_user_playlist_songs.playlist_id
             AND p.user_id = $3
         )`,
      [playlistId, songId, userId]
    );

    await this.touchPlaylist(playlistId, userId);

    return this.getPlaylists(userId);
  }

  async getRecentlyPlayedSongs(userId: string, limit = 100): Promise<Song[]> {
    const result = await this.database.query(
      `WITH latest AS (
         SELECT
           e.song_id,
           MAX(e.started_at) AS latest_started_at
         FROM app_listening_events e
         WHERE e.user_id = $1
         GROUP BY e.song_id
       )
       SELECT song_id
       FROM latest
       ORDER BY latest_started_at DESC
       LIMIT $2`,
      [userId, Math.max(1, Math.min(limit, 200))]
    );

    const ids = this.rows<FavoriteRow>(result).map((row) => row.song_id);
    return this.songsByIds(ids);
  }

  private async touchPlaylist(playlistId: string, userId: string): Promise<void> {
    await this.database.query(
      `UPDATE app_user_playlists
       SET updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [playlistId, userId]
    );
  }

  private async songsByIds(ids: string[]): Promise<Song[]> {
    const uniqueIds = Array.from(new Set(ids)).filter(Boolean);

    if (!uniqueIds.length) {
      return [];
    }

    const allSongs = await this.googleDriveService.listSongs();
    const songMap = new Map(allSongs.map((song) => [song.id, song]));

    return uniqueIds
      .map((id) => songMap.get(id))
      .filter((song): song is Song => Boolean(song));
  }

  private rows<T>(result: unknown): T[] {
    const items = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows ?? [];
    return items as T[];
  }

  private iso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}
