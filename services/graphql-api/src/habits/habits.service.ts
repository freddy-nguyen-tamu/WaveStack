import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { MusicService } from "../music/music.service";
import { Song } from "../music/music.models";
import { HabitSummaryEntry, RecommendSongResult } from "./habits.models";
import { DrivePrivateExportService, ListeningHabitExportPayload } from "./drive-private-export.service";

type QueryRows<T> = { rows: T[] } | T[];

type PlayCountRow = {
  song_id: string;
  play_count: string | number;
};

type HabitSummaryRow = {
  label: string;
  count: string | number;
  total_duration_seconds: string | number;
};

type RecentListenRow = {
  song_id: string;
};

type ListeningEventExportRow = {
  song_id: string;
  artist_name: string;
  title: string;
  duration_seconds: string | number;
  completed_play_ratio: string | number;
  started_at: Date | string;
};

@Injectable()
export class HabitsService {
  private readonly logger = new Logger(HabitsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly musicService: MusicService,
    private readonly drivePrivateExport: DrivePrivateExportService
  ) {}

  async recordListen(
    userId: string,
    songId: string,
    artistName: string,
    title: string,
    durationSeconds: number,
    completedPlayRatio: number
  ): Promise<boolean> {
    try {
      await this.database.query(
        `INSERT INTO app_listening_events (user_id, song_id, artist_name, title, duration_seconds, completed_play_ratio)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, songId, artistName, title, durationSeconds, completedPlayRatio]
      );

      return true;
    } catch (error) {
      this.logger.error(`Failed to record listen: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async recommendSongs(
    userId: string | null,
    limit = 24,
    options: {
      favoriteSongIds?: string[];
      recentSongIds?: string[];
    } = {}
  ): Promise<RecommendSongResult[]> {
    const allSongs = await this.getRecommendationPool(Math.max(limit * 30, 500));

    if (!allSongs.length) {
      return [];
    }

    const shuffled = [...allSongs].sort(() => Math.random() - 0.5);
    const byId = new Map(allSongs.map((song) => [song.id, song]));

    if (!userId) {
      return shuffled.slice(0, limit).map((song) => ({
        song,
        reason: "Random pick"
      }));
    }

    const playCounts = await this.getPlayCounts(userId);
    const backendRecentIds = await this.getRecentListenIds(userId, 30);

    const favoriteIds = uniqueStrings(options.favoriteSongIds ?? []);
    const frontendRecentIds = uniqueStrings(options.recentSongIds ?? []);

    const seedIds = uniqueStrings([
      ...favoriteIds,
      ...frontendRecentIds,
      ...backendRecentIds,
      ...Array.from(playCounts.keys())
    ]);

    if (!seedIds.length) {
      return shuffled.slice(0, limit).map((song) => ({
        song,
        reason: "Random pick (no listening history yet)"
      }));
    }

    const seedSongs = seedIds
      .map((id) => byId.get(id))
      .filter((song): song is Song => Boolean(song));

    const seedArtists = new Map<string, number>();
    const seedAlbums = new Map<string, number>();
    const seedGenres = new Map<string, number>();

    for (const seed of seedSongs) {
      addWeighted(seedArtists, normalize(seed.artistName), 1);
      addWeighted(seedAlbums, normalize(seed.albumTitle), 1);

      for (const genre of seed.genreNames ?? []) {
        addWeighted(seedGenres, normalize(genre), 1);
      }
    }

    const seedSet = new Set(seedIds);
    const favoriteSet = new Set(favoriteIds);
    const frontendRecentSet = new Set(frontendRecentIds);
    const backendRecentSet = new Set(backendRecentIds);

    const scored = allSongs.map((song) => {
      let score = Math.random() * 2;
      const reasons: string[] = [];

      const playCount = playCounts.get(song.id) ?? 0;

      if (playCount > 0) {
        score += playCount * 7;
        reasons.push(`played ${playCount} time(s)`);
      }

      if (favoriteSet.has(song.id)) {
        score += 30;
        reasons.push("favorited");
      }

      if (frontendRecentSet.has(song.id) || backendRecentSet.has(song.id)) {
        score += 18;
        reasons.push("recently played");
      }

      const artistWeight = seedArtists.get(normalize(song.artistName)) ?? 0;

      if (artistWeight > 0) {
        score += 45 + artistWeight * 4;
        reasons.push(`same artist: ${song.artistName || "Unknown Artist"}`);
      }

      const albumWeight = seedAlbums.get(normalize(song.albumTitle)) ?? 0;

      if (albumWeight > 0) {
        score += 14 + albumWeight * 2;
        reasons.push(`same album/source: ${song.albumTitle || "Unknown Album"}`);
      }

      const matchedGenres = (song.genreNames ?? [])
        .map((genre) => normalize(genre))
        .filter((genre) => seedGenres.has(genre));

      if (matchedGenres.length) {
        score += matchedGenres.length * 12;
        reasons.push(`shared genre: ${matchedGenres.slice(0, 2).join(", ")}`);
      }

      if (seedSet.has(song.id)) {
        score -= 16;
      }

      return {
        song,
        score,
        reason: reasons.length ? reasons.slice(0, 2).join("; ") : "Discovery"
      };
    });

    scored.sort((a, b) => b.score - a.score);

    const output: RecommendSongResult[] = [];

    for (const item of scored) {
      if (output.some((existing) => existing.song.id === item.song.id)) {
        continue;
      }

      output.push({
        song: item.song,
        reason: item.reason
      });

      if (output.length >= limit) {
        break;
      }
    }

    return output;
  }

  private async getRecommendationPool(limit: number): Promise<Song[]> {
    const musicService = this.musicService as MusicService & {
      songPage?: (first: number, after?: string | null, query?: string | null) => Promise<{ nodes: Song[] }>;
      dashboardSongs?: (limit: number) => Promise<Song[]>;
    };

    if (musicService.songPage) {
      const page = await musicService.songPage(limit, null, null);
      return page.nodes;
    }

    if (musicService.dashboardSongs) {
      return musicService.dashboardSongs(limit);
    }

    return this.musicService.listSongs();
  }

  private async getPlayCounts(userId: string): Promise<Map<string, number>> {
    const result = await this.database.query(
      `SELECT song_id, COUNT(*) AS play_count
       FROM app_listening_events
       WHERE user_id = $1
       GROUP BY song_id
       ORDER BY play_count DESC
       LIMIT 100`,
      [userId]
    );

    const rows = this.rows(result) as PlayCountRow[];
    const playCounts = new Map<string, number>();

    for (const row of rows) {
      playCounts.set(row.song_id, Number(row.play_count));
    }

    return playCounts;
  }

  private async getRecentListenIds(userId: string, limit: number): Promise<string[]> {
    const result = await this.database.query(
      `SELECT song_id
       FROM (
         SELECT song_id, MAX(started_at) AS last_played_at
         FROM app_listening_events
         WHERE user_id = $1
         GROUP BY song_id
       ) recent
       ORDER BY last_played_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    const rows = this.rows(result) as RecentListenRow[];

    return rows.map((row) => row.song_id);
  }

  async summarize(userId: string, period: "DAY" | "WEEK" | "MONTH" | "YEAR"): Promise<HabitSummaryEntry[]> {
    const interval = this.periodIntervalSql(period);

    const result = await this.database.query(
      `SELECT
         COALESCE(NULLIF(artist_name, ''), 'Unknown') AS label,
         COUNT(*)::int AS count,
         COALESCE(SUM(duration_seconds), 0)::float8 AS total_duration_seconds
       FROM app_listening_events
       WHERE user_id = $1 AND started_at >= now() - ${interval}
       GROUP BY label
       ORDER BY count DESC
       LIMIT 10`,
      [userId]
    );

    return (this.rows(result) as HabitSummaryRow[]).map((row) => ({
      label: row.label,
      count: Number(row.count),
      totalDurationSeconds: Number(row.total_duration_seconds)
    }));
  }

  async testDriveWrite(): Promise<{
    ok: boolean;
    message: string;
    folderId?: string;
    credentialsPath?: string;
    fileId?: string;
    webViewLink?: string;
  }> {
    return this.drivePrivateExport.assertWritable();
  }

  async exportToDrive(
    userId: string,
    period: "DAY" | "WEEK" | "MONTH" | "YEAR" | "ALL" = "ALL"
  ): Promise<{
    ok: boolean;
    message: string;
    fileId?: string;
    webViewLink?: string;
  }> {
    const events = await this.getEventsForExport(userId, period);
    const summaries: Record<string, unknown> = {};

    for (const p of ["DAY", "WEEK", "MONTH", "YEAR"] as const) {
      summaries[p] = await this.summarize(userId, p);
    }

    const payload: ListeningHabitExportPayload = {
      userId,
      period,
      generatedAt: new Date().toISOString(),
      events,
      summaries
    };

    return this.drivePrivateExport.exportListeningHabits(payload);
  }

  private async getEventsForExport(
    userId: string,
    period: "DAY" | "WEEK" | "MONTH" | "YEAR" | "ALL"
  ): Promise<ListeningHabitExportPayload["events"]> {
    const intervalWhere =
      period === "ALL"
        ? ""
        : `AND started_at >= now() - ${this.periodIntervalSql(period)}`;

    const result = await this.database.query(
      `SELECT
         song_id,
         artist_name,
         title,
         duration_seconds,
         completed_play_ratio,
         started_at
       FROM app_listening_events
       WHERE user_id = $1
       ${intervalWhere}
       ORDER BY started_at DESC
       LIMIT 5000`,
      [userId]
    );

    return (this.rows(result) as ListeningEventExportRow[]).map((row) => ({
      songId: row.song_id,
      artistName: row.artist_name,
      title: row.title,
      durationSeconds: Number(row.duration_seconds),
      completedPlayRatio: Number(row.completed_play_ratio),
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at)
    }));
  }

  private periodIntervalSql(period: "DAY" | "WEEK" | "MONTH" | "YEAR"): string {
    const intervalMap: Record<"DAY" | "WEEK" | "MONTH" | "YEAR", string> = {
      DAY: "interval '24 hours'",
      WEEK: "interval '7 days'",
      MONTH: "interval '30 days'",
      YEAR: "interval '365 days'"
    };

    return intervalMap[period];
  }

  private rows<T>(result: QueryRows<T>): T[] {
    return Array.isArray(result) ? result : result.rows;
  }
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function addWeighted(map: Map<string, number>, key: string, weight: number): void {
  if (!key) {
    return;
  }

  map.set(key, (map.get(key) ?? 0) + weight);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
