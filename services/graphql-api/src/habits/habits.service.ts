import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { MusicService } from "../music/music.service";
import { Song } from "../music/music.models";
import {
  HabitSummaryEntry,
  ListeningStatsEntry,
  ListeningStatsSnapshot,
  PlacementPoint,
  RecentlyPlayedEntry,
  RecommendSongResult
} from "./habits.models";
import { DrivePrivateExportService, ListeningHabitExportPayload } from "./drive-private-export.service";

type QueryRows<T> = { rows: T[] } | T[];

type StatsPeriod = "FOUR_WEEKS" | "SIX_MONTHS" | "TWELVE_MONTHS" | "ALL_TIME";

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
      offset?: number;
    } = {}
  ): Promise<RecommendSongResult[]> {
    const totalNeeded = limit + (options.offset ?? 0);
    const allSongs = await this.getRecommendationPool(Math.max(totalNeeded * 30, 500));

    if (!allSongs.length) {
      return [];
    }

    const shuffled = [...allSongs].sort(() => Math.random() - 0.5);
    const byId = new Map(allSongs.map((song) => [song.id, song]));

    if (!userId) {
      return shuffled.slice(options.offset ?? 0, totalNeeded).map((song) => ({
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
      return shuffled.slice(options.offset ?? 0, totalNeeded).map((song) => ({
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

      if (output.length >= totalNeeded) {
        break;
      }
    }

    return output.slice(options.offset ?? 0, totalNeeded);
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

  private statsPeriodIntervalSql(period: StatsPeriod): string {
    const map: Record<StatsPeriod, string> = {
      FOUR_WEEKS: "interval '28 days'",
      SIX_MONTHS: "interval '182 days'",
      TWELVE_MONTHS: "interval '365 days'",
      ALL_TIME: "interval '9999 days'"
    };

    return map[period];
  }

  async topTracks(userId: string, period: StatsPeriod, limit = 50): Promise<ListeningStatsEntry[]> {
    const interval = this.statsPeriodIntervalSql(period);

    const result = await this.database.query(
      `SELECT
         song_id,
         COALESCE(NULLIF(title, ''), 'Unknown') AS title,
         COALESCE(NULLIF(artist_name, ''), 'Unknown') AS artist_name,
         COUNT(*)::int AS play_count
       FROM app_listening_events
       WHERE user_id = $1 AND started_at >= now() - ${interval}
       GROUP BY song_id, title, artist_name
       ORDER BY play_count DESC
       LIMIT $2`,
      [userId, limit]
    );

    return (this.rows(result) as Array<{ song_id: string; title: string; artist_name: string; play_count: string | number }>)
      .map((row, index) => ({
        songId: row.song_id,
        title: row.title,
        artistName: row.artist_name,
        playCount: Number(row.play_count),
        position: index + 1
      }));
  }

  async topArtists(userId: string, period: StatsPeriod, limit = 50): Promise<ListeningStatsEntry[]> {
    const interval = this.statsPeriodIntervalSql(period);

    const result = await this.database.query(
      `SELECT
         COALESCE(NULLIF(artist_name, ''), 'Unknown') AS artist_name,
         COUNT(*)::int AS play_count
       FROM app_listening_events
       WHERE user_id = $1 AND started_at >= now() - ${interval}
       GROUP BY artist_name
       ORDER BY play_count DESC
       LIMIT $2`,
      [userId, limit]
    );

    return (this.rows(result) as Array<{ artist_name: string; play_count: string | number }>)
      .map((row, index) => ({
        songId: "",
        title: "",
        artistName: row.artist_name,
        playCount: Number(row.play_count),
        position: index + 1
      }));
  }

  async topGenres(userId: string, period: StatsPeriod, limit = 50): Promise<ListeningStatsEntry[]> {
    const interval = this.statsPeriodIntervalSql(period);

    const result = await this.database.query(
      `WITH song_genres AS (
         SELECT unnest(dt.genre_names) AS genre_name
         FROM app_listening_events ale
         JOIN drive_tracks dt ON dt.file_id = ale.song_id
         WHERE ale.user_id = $1 AND ale.started_at >= now() - ${interval}
       )
       SELECT
         COALESCE(NULLIF(genre_name, ''), 'Unknown') AS genre_name,
         COUNT(*)::int AS play_count
       FROM song_genres
       GROUP BY genre_name
       ORDER BY play_count DESC
       LIMIT $2`,
      [userId, limit]
    );

    return (this.rows(result) as Array<{ genre_name: string; play_count: string | number }>)
      .map((row, index) => ({
        songId: "",
        title: row.genre_name,
        artistName: "",
        playCount: Number(row.play_count),
        position: index + 1
      }));
  }

  async recentlyPlayedDetailed(userId: string, period: StatsPeriod, limit = 50): Promise<RecentlyPlayedEntry[]> {
    const interval = this.statsPeriodIntervalSql(period);

    const result = await this.database.query(
      `SELECT
         song_id,
         COALESCE(NULLIF(title, ''), 'Unknown') AS title,
         COALESCE(NULLIF(artist_name, ''), 'Unknown') AS artist_name,
         started_at,
         completed_play_ratio
       FROM app_listening_events
       WHERE user_id = $1 AND started_at >= now() - ${interval}
       ORDER BY started_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return (this.rows(result) as Array<{
      song_id: string; title: string; artist_name: string; started_at: Date | string; completed_play_ratio: string | number;
    }>).map((row) => ({
      songId: row.song_id,
      title: row.title,
      artistName: row.artist_name,
      playedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
      completedPlayRatio: Number(row.completed_play_ratio)
    }));
  }

  async saveStatsSnapshot(
    userId: string,
    label: string,
    topTrackEntries: ListeningStatsEntry[],
    topArtistEntries: ListeningStatsEntry[],
    topGenreEntries: ListeningStatsEntry[]
  ): Promise<ListeningStatsSnapshot> {
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();

    await this.database.query(
      `INSERT INTO app_stats_snapshots (id, user_id, label, created_at) VALUES ($1, $2, $3, $4)`,
      [id, userId, label, createdAt]
    );

    const entries: Array<{ category: string; song_id: string | null; artist_name: string; play_count: number; position: number }> = [
      ...topTrackEntries.map((e, i) => ({ category: "TRACK", song_id: e.songId || null, artist_name: e.title || e.artistName, play_count: e.playCount, position: i + 1 })),
      ...topArtistEntries.map((e, i) => ({ category: "ARTIST", song_id: null, artist_name: e.artistName, play_count: e.playCount, position: i + 1 })),
      ...topGenreEntries.map((e, i) => ({ category: "GENRE", song_id: null, artist_name: e.title || e.artistName, play_count: e.playCount, position: i + 1 }))
    ];

    for (const entry of entries) {
      const entryId = `snap-${id}-${entry.category}-${entry.position}`;
      await this.database.query(
        `INSERT INTO app_stats_snapshot_entries (id, snapshot_id, category, position, song_id, artist_name, play_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entryId, id, entry.category, entry.position, entry.song_id, entry.artist_name, entry.play_count]
      );
    }

    return {
      id,
      label,
      createdAt,
      entries: [...topTrackEntries, ...topArtistEntries, ...topGenreEntries]
    };
  }

  async previousStatsSnapshots(userId: string): Promise<ListeningStatsSnapshot[]> {
    const snapResult = await this.database.query(
      `SELECT id, label, created_at
       FROM app_stats_snapshots
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );

    const snapRows = this.rows(snapResult) as Array<{ id: string; label: string; created_at: Date | string }>;

    const snapshots: ListeningStatsSnapshot[] = [];

    for (const row of snapRows) {
      const entryResult = await this.database.query(
        `SELECT category, position, song_id, artist_name, play_count
         FROM app_stats_snapshot_entries
         WHERE snapshot_id = $1
         ORDER BY category, position`,
        [row.id]
      );

      const entryRows = this.rows(entryResult) as Array<{
        category: string; position: string | number; song_id: string | null; artist_name: string; play_count: string | number;
      }>;

      snapshots.push({
        id: row.id,
        label: row.label,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        entries: entryRows.map((e) => ({
          songId: e.song_id ?? "",
          title: e.artist_name,
          artistName: e.artist_name,
          playCount: Number(e.play_count),
          position: Number(e.position)
        }))
      });
    }

    return snapshots;
  }

  async placementHistory(userId: string, songId: string): Promise<PlacementPoint[]> {
    const result = await this.database.query(
      `SELECT ss.id, ss.label, ss.created_at, sse.position
       FROM app_stats_snapshot_entries sse
       JOIN app_stats_snapshots ss ON ss.id = sse.snapshot_id
       WHERE ss.user_id = $1 AND sse.song_id = $2 AND sse.category = 'TRACK'
       ORDER BY ss.created_at ASC`,
      [userId, songId]
    );

    const rows = this.rows(result) as Array<{
      id: string; label: string; created_at: Date | string; position: string | number;
    }>;

    return rows.map((row) => ({
      snapshotId: row.id,
      label: row.label,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      position: Number(row.position)
    }));
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
