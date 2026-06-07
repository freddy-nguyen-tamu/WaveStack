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
  RecommendSongResult,
  RecommendedSongsPage,
  TasteComparisonResult,
  TasteJudgeResult
} from "./habits.models";
import { DrivePrivateExportService } from "./drive-private-export.service";
import { GroqTasteService } from "./groq-taste.service";

type QueryRows<T> = { rows: T[] } | T[];

type StatsPeriod = "FOUR_WEEKS" | "SIX_MONTHS" | "TWELVE_MONTHS" | "ALL_TIME";

type TasteWritingStyle = {
  phrase?: string;
  example?: string;
};

type StatsEntryRow = {
  key: string;
  label: string;
  subtitle: string | null;
  rank: string | number;
  previous_rank: string | number;
  rank_change: string | number;
  play_count: string | number;
  total_duration_seconds: string | number;
  song_id: string | null;
  thumbnail_url: string | null;
};

type SnapshotRow = {
  id: string;
  stat_type: string;
  period: string;
  label: string;
  generated_at: Date | string;
};

type RecentListenExportRow = {
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
    private readonly drivePrivateExport: DrivePrivateExportService,
    private readonly groqTasteService: GroqTasteService
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

  async recommendSongsPage(
    userId: string | null,
    options: {
      limit: number;
      offset: number;
      favoriteSongIds: string[];
      recentSongIds: string[];
      excludedSongIds: string[];
    }
  ): Promise<RecommendedSongsPage> {
    const safeLimit = Math.max(1, Math.min(options.limit, 60));
    const safeOffset = Math.max(0, options.offset);
    const excludedSet = new Set(uniqueStrings(options.excludedSongIds));

    const allSongs = (await this.getRecommendationPool(10000)).filter((song) => !excludedSet.has(song.id));

    if (!allSongs.length) {
      return {
        nodes: [],
        totalCount: 0,
        hasNextPage: false,
        nextOffset: safeOffset
      };
    }

    const byId = new Map(allSongs.map((song) => [song.id, song]));
    const favoriteIds = uniqueStrings(options.favoriteSongIds);
    const frontendRecentIds = uniqueStrings(options.recentSongIds);
    const favoriteSet = new Set(favoriteIds);
    const frontendRecentSet = new Set(frontendRecentIds);

    let backendRecentIds: string[] = [];
    let playCounts = new Map<string, number>();

    if (userId) {
      backendRecentIds = await this.getRecentListenIds(userId, 80);
      playCounts = await this.getPlayCounts(userId);
    }

    const backendRecentSet = new Set(backendRecentIds);

    const seedIds = uniqueStrings([
      ...favoriteIds,
      ...frontendRecentIds,
      ...backendRecentIds,
      ...Array.from(playCounts.keys())
    ]);

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

    const scored = allSongs.map((song) => {
      let score = stableSongScore(song.id);
      const reasons: string[] = [];

      const playCount = playCounts.get(song.id) ?? 0;

      if (playCount > 0) {
        score += playCount * 6;
        reasons.push(`played ${playCount} time(s)`);
      }

      if (favoriteSet.has(song.id)) {
        score += 30;
        reasons.push("favorited");
      }

      if (frontendRecentSet.has(song.id) || backendRecentSet.has(song.id)) {
        score += 16;
        reasons.push("recently played");
      }

      const artistWeight = seedArtists.get(normalize(song.artistName)) ?? 0;
      const albumWeight = seedAlbums.get(normalize(song.albumTitle)) ?? 0;
      const genreWeight = (song.genreNames ?? []).reduce(
        (sum, genre) => sum + (seedGenres.get(normalize(genre)) ?? 0),
        0
      );

      if (artistWeight > 0) {
        score += artistWeight * 10;
        reasons.push("same artist");
      }

      if (albumWeight > 0) {
        score += albumWeight * 4;
        reasons.push("same source");
      }

      if (genreWeight > 0) {
        score += genreWeight * 5;
        reasons.push("similar genre");
      }

      if (!reasons.length) {
        reasons.push(userId ? "explore your library" : "random pick");
      }

      return {
        song,
        score,
        reason: reasons.slice(0, 2).join(", ")
      };
    });

    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.song.id.localeCompare(right.song.id);
    });

    const totalCount = scored.length;
    const page = scored.slice(safeOffset, safeOffset + safeLimit);

    return {
      nodes: page.map((item) => ({
        song: item.song,
        reason: item.reason
      })),
      totalCount,
      hasNextPage: safeOffset + safeLimit < totalCount,
      nextOffset: safeOffset + page.length
    };
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

    const rows = this.rows(result) as Array<{ song_id: string; play_count: string | number }>;
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

    const rows = this.rows(result) as Array<{ song_id: string }>;

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

    return (this.rows(result) as Array<{ label: string; count: string | number; total_duration_seconds: string | number }>)
      .map((row) => ({
        label: row.label,
        count: Number(row.count),
        totalDurationSeconds: Number(row.total_duration_seconds)
      }));
  }

  async getUserByEmail(email: string): Promise<{ id: string; email: string } | null> {
    const result = await this.database.query(
      `SELECT id, email FROM users WHERE email = $1`,
      [email]
    );
    const rows = this.rows(result) as Array<{ id: string; email: string }>;
    return rows.length > 0 ? rows[0] : null;
  }

  async testDriveWrite(): Promise<{
    ok: boolean;
    message: string;
    folderId?: string;
  }> {
    try {
      const folderId = await this.drivePrivateExport.ensureRootFolder();
      return { ok: true, message: "Root folder ready", folderId };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async exportToDrive(
    userId: string,
    period: "DAY" | "WEEK" | "MONTH" | "YEAR" | "ALL" = "ALL"
  ): Promise<{
    ok: boolean;
    message: string;
    webViewLink?: string;
  }> {
    try {
      const intervalWhere = period === "ALL" ? "" : `AND started_at >= now() - ${this.periodIntervalSql(period as "DAY" | "WEEK" | "MONTH" | "YEAR")}`;

      const result = await this.database.query(
        `SELECT
           song_id, artist_name, title, duration_seconds, completed_play_ratio, started_at
         FROM app_listening_events
         WHERE user_id = $1 ${intervalWhere}
         ORDER BY started_at DESC
         LIMIT 5000`,
        [userId]
      );

      const rows = this.rows(result) as RecentListenExportRow[];
      const header = "Song ID,Artist,Title,Duration (s),Completion Ratio,Started At";
      const csvRows = rows.map((r) =>
        `"${r.song_id}","${r.artist_name}","${r.title}",${r.duration_seconds},${r.completed_play_ratio},"${r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at}"`
      );
      const csv = [header, ...csvRows].join("\n");

      const link = await this.drivePrivateExport.exportData(
        userId,
        csv,
        `listening-history-${period.toLowerCase()}-${new Date().toISOString().split("T")[0]}.csv`,
        "text/csv"
      );
      return { ok: true, message: "Exported", webViewLink: link };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
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
    switch (period) {
      case "FOUR_WEEKS": return "interval '28 days'";
      case "SIX_MONTHS": return "interval '182 days'";
      case "TWELVE_MONTHS": return "interval '365 days'";
      case "ALL_TIME": return "interval '36500 days'";
      default: return "interval '28 days'";
    }
  }

  async topTracks(userId: string, period: StatsPeriod, limit = 50): Promise<ListeningStatsEntry[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const periodWhere = this.statsPeriodWhereAlias("e", period);
    const rollupWhere = this.rollupPeriodWhere("r", period);

    const result = await this.database.query(
      `WITH combined AS (
        SELECT
          e.song_id,
          COALESCE(NULLIF(e.title, ''), 'Unknown Track') AS title,
          COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist') AS artist_name,
          1::int AS play_count,
          COALESCE(e.duration_seconds, 0)::int AS total_duration_seconds
        FROM app_listening_events e
        WHERE e.user_id = $1
          ${periodWhere}

        UNION ALL

        SELECT
          r.song_id,
          COALESCE(NULLIF(r.title, ''), 'Unknown Track') AS title,
          COALESCE(NULLIF(r.artist_name, ''), 'Unknown Artist') AS artist_name,
          r.play_count::int AS play_count,
          r.total_duration_seconds::int AS total_duration_seconds
        FROM app_listening_monthly_rollups r
        WHERE r.user_id = $1
          ${rollupWhere}
      ),
      grouped AS (
        SELECT
          song_id AS key,
          MAX(title) AS label,
          MAX(artist_name) AS subtitle,
          SUM(play_count)::int AS play_count,
          SUM(total_duration_seconds)::float8 AS total_duration_seconds,
          song_id
        FROM combined
        GROUP BY song_id
      )
      SELECT
        g.key,
        g.label,
        g.subtitle,
        ROW_NUMBER() OVER (ORDER BY g.play_count DESC, g.total_duration_seconds DESC, g.label ASC)::int AS rank,
        0 AS previous_rank,
        0 AS rank_change,
        g.play_count,
        g.total_duration_seconds,
        g.song_id,
        MAX(COALESCE(t.local_thumbnail_url, t.thumbnail_url, t.drive_thumbnail_url, t.embedded_artwork_url)) AS thumbnail_url
      FROM grouped g
      LEFT JOIN drive_tracks t ON t.id = g.song_id OR t.drive_file_id = g.song_id
      GROUP BY g.key, g.label, g.subtitle, g.play_count, g.total_duration_seconds, g.song_id
      ORDER BY rank ASC
      LIMIT $2`,
      [userId, safeLimit]
    );

    return this.mapStatsEntries(this.rows(result));
  }

  async topArtists(userId: string, period: StatsPeriod, limit = 50): Promise<ListeningStatsEntry[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const periodWhere = this.statsPeriodWhereAlias("e", period);
    const rollupWhere = this.rollupPeriodWhere("r", period);

    const result = await this.database.query(
      `WITH combined AS (
        SELECT
          COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist') AS artist_name,
          e.song_id,
          1::int AS play_count,
          COALESCE(e.duration_seconds, 0)::int AS total_duration_seconds
        FROM app_listening_events e
        WHERE e.user_id = $1
          ${periodWhere}

        UNION ALL

        SELECT
          COALESCE(NULLIF(r.artist_name, ''), 'Unknown Artist') AS artist_name,
          r.song_id,
          r.play_count::int AS play_count,
          r.total_duration_seconds::int AS total_duration_seconds
        FROM app_listening_monthly_rollups r
        WHERE r.user_id = $1
          ${rollupWhere}
      ),
      grouped AS (
        SELECT
          lower(artist_name) AS key,
          artist_name AS label,
          COUNT(DISTINCT song_id)::int AS distinct_tracks,
          SUM(play_count)::int AS play_count,
          SUM(total_duration_seconds)::float8 AS total_duration_seconds
        FROM combined
        GROUP BY lower(artist_name), artist_name
      )
      SELECT
        key,
        label,
        distinct_tracks::text || ' track(s)' AS subtitle,
        ROW_NUMBER() OVER (ORDER BY play_count DESC, total_duration_seconds DESC, label ASC)::int AS rank,
        0 AS previous_rank,
        0 AS rank_change,
        play_count,
        total_duration_seconds,
        NULL::text AS song_id,
        NULL::text AS thumbnail_url
      FROM grouped
      ORDER BY rank ASC
      LIMIT $2`,
      [userId, safeLimit]
    );

    return this.mapStatsEntries(this.rows(result));
  }

  async topGenres(userId: string, period: StatsPeriod, limit = 50): Promise<ListeningStatsEntry[]> {
    const interval = this.statsPeriodIntervalSql(period);

    const result = await this.database.query(
      `SELECT
         COALESCE(NULLIF(genre_name, ''), 'Unknown') AS key,
         COALESCE(NULLIF(genre_name, ''), 'Unknown') AS label,
         '' AS subtitle,
         ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC)::int AS rank,
         0 AS previous_rank,
         0 AS rank_change,
         COUNT(*)::int AS play_count,
         0::float8 AS total_duration_seconds,
         NULL AS song_id,
         NULL AS thumbnail_url
       FROM (
         SELECT unnest(dt.genre_names) AS genre_name
         FROM app_listening_events ale
         LEFT JOIN drive_tracks dt ON dt.id = ale.song_id OR dt.drive_file_id = ale.song_id
         WHERE ale.user_id = $1 AND ale.started_at >= now() - ${interval}
       ) sub
       GROUP BY genre_name
       ORDER BY play_count DESC
       LIMIT $2`,
      [userId, limit]
    );

    return this.mapStatsEntries(this.rows(result));
  }

  async recentlyPlayedDetailed(userId: string, period: StatsPeriod, limit = 50): Promise<RecentlyPlayedEntry[]> {
    const interval = this.statsPeriodIntervalSql(period);

    const result = await this.database.query(
      `SELECT
         song_id,
         COALESCE(NULLIF(title, ''), 'Unknown') AS title,
         COALESCE(NULLIF(artist_name, ''), 'Unknown') AS artist_name,
         duration_seconds,
         completed_play_ratio,
         started_at
       FROM app_listening_events
       WHERE user_id = $1 AND started_at >= now() - ${interval}
       ORDER BY started_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return (this.rows(result) as Array<{
      song_id: string; title: string; artist_name: string;
      duration_seconds: string | number;
      completed_play_ratio: string | number; started_at: Date | string;
    }>).map((row) => ({
      songId: row.song_id,
      title: row.title,
      artistName: row.artist_name,
      durationSeconds: Number(row.duration_seconds),
      completedPlayRatio: Number(row.completed_play_ratio),
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at)
    }));
  }

  private mapStatsEntries(rows: unknown[]): ListeningStatsEntry[] {
    return (rows as StatsEntryRow[]).map((r) => ({
      key: r.key,
      label: r.label,
      subtitle: r.subtitle ?? "",
      rank: Number(r.rank),
      previousRank: Number(r.previous_rank),
      rankChange: Number(r.rank_change),
      playCount: Number(r.play_count),
      totalDurationSeconds: Number(r.total_duration_seconds),
      songId: r.song_id ?? undefined,
      thumbnailUrl: r.thumbnail_url ?? undefined,
    }));
  }

  async saveStatsSnapshot(
    userId: string,
    statType: string,
    period: string,
    label: string,
    entries: ListeningStatsEntry[]
  ): Promise<ListeningStatsSnapshot> {
    const snapResult = await this.database.query(
      `INSERT INTO listening_stat_snapshots (stat_type, period, label, generated_at)
       VALUES ($1, $2, $3, now())
       RETURNING id, stat_type, period, label, generated_at`,
      [statType, period, label]
    );

    const snap = (this.rows(snapResult) as SnapshotRow[])[0];

    for (const entry of entries) {
      await this.database.query(
        `INSERT INTO listening_stat_entries
           (snapshot_id, key, label, subtitle, rank, previous_rank, rank_change,
            play_count, total_duration_seconds, song_id, thumbnail_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          snap.id, entry.key, entry.label, entry.subtitle,
          entry.rank, entry.previousRank, entry.rankChange,
          entry.playCount, entry.totalDurationSeconds,
          entry.songId ?? null, entry.thumbnailUrl ?? null
        ]
      );
    }

    return {
      id: snap.id,
      statType: snap.stat_type,
      period: snap.period,
      label: snap.label,
      generatedAt: snap.generated_at instanceof Date ? snap.generated_at.toISOString() : String(snap.generated_at),
      entries
    };
  }

  async previousStatsSnapshots(userId: string): Promise<ListeningStatsSnapshot[]> {
    const result = await this.database.query(
      `SELECT id, stat_type, period, label, generated_at
       FROM listening_stat_snapshots
       ORDER BY generated_at DESC
       LIMIT 20`
    );

    const snaps = this.rows(result) as SnapshotRow[];
    const snapshots: ListeningStatsSnapshot[] = [];

    for (const snap of snaps) {
      const entryResult = await this.database.query(
        `SELECT key, label, subtitle, rank, previous_rank, rank_change,
                play_count, total_duration_seconds, song_id, thumbnail_url
         FROM listening_stat_entries
         WHERE snapshot_id = $1
         ORDER BY rank`,
        [snap.id]
      );

      snapshots.push({
        id: snap.id,
        statType: snap.stat_type,
        period: snap.period,
        label: snap.label,
        generatedAt: snap.generated_at instanceof Date ? snap.generated_at.toISOString() : String(snap.generated_at),
        entries: this.mapStatsEntries(this.rows(entryResult))
      });
    }

    return snapshots;
  }

  async placementHistory(userId: string, key: string): Promise<PlacementPoint[]> {
    const result = await this.database.query(
      `SELECT ss.id, ss.generated_at, se.rank
       FROM listening_stat_entries se
       JOIN listening_stat_snapshots ss ON ss.id = se.snapshot_id
       WHERE se.key = $1
       ORDER BY ss.generated_at ASC`,
      [key]
    );

    const rows = this.rows(result) as Array<{
      id: string; generated_at: Date | string; rank: string | number;
    }>;

    return rows.map((row) => ({
      snapshotId: row.id,
      generatedAt: row.generated_at instanceof Date ? row.generated_at.toISOString() : String(row.generated_at),
      rank: Number(row.rank)
    }));
  }

  private statsPeriodWhere(period: string): string {
    if (period === "ALL_TIME") return "";
    const map: Record<string, string> = {
      FOUR_WEEKS: "AND started_at >= now() - interval '28 days'",
      SIX_MONTHS: "AND started_at >= now() - interval '182 days'",
      TWELVE_MONTHS: "AND started_at >= now() - interval '365 days'",
    };
    return map[period] ?? "";
  }

  private statsPeriodWhereAlias(alias: string, period: string): string {
    if (period === "ALL_TIME") return "";

    const map: Record<string, string> = {
      FOUR_WEEKS: `AND ${alias}.started_at >= now() - interval '28 days'`,
      SIX_MONTHS: `AND ${alias}.started_at >= now() - interval '182 days'`,
      TWELVE_MONTHS: `AND ${alias}.started_at >= now() - interval '365 days'`,
    };

    return map[period] ?? "";
  }

  private rollupPeriodWhere(alias: string, period: string): string {
    if (period === "ALL_TIME") return "";

    const map: Record<string, string> = {
      FOUR_WEEKS: `AND ${alias}.month_start >= (current_date - interval '28 days')::date`,
      SIX_MONTHS: `AND ${alias}.month_start >= (current_date - interval '182 days')::date`,
      TWELVE_MONTHS: `AND ${alias}.month_start >= (current_date - interval '365 days')::date`,
    };

    return map[period] ?? "";
  }

  async judgeTaste(userId: string, period = "ALL_TIME", writingStyle: TasteWritingStyle = {}): Promise<TasteJudgeResult> {
    const generatedAt = new Date().toISOString();
    const stylePhrase = writingStyle.phrase?.trim().slice(0, 180);
    const styleExample = writingStyle.example?.trim().slice(0, 900);

    const [topTracks, topArtists, topGenres, recent, comparison] = await Promise.all([
      this.topTracks(userId, period as StatsPeriod, 25),
      this.topArtists(userId, period as StatsPeriod, 25),
      this.topGenres(userId, period as StatsPeriod, 25),
      this.recentlyPlayedDetailed(userId, period as StatsPeriod, 30),
      this.tasteComparison(userId, period)
    ]);

    if (!topTracks.length && !topArtists.length) {
      return {
        ok: false,
        verdictTitle: "Not enough data",
        roast: "I wanted to judge your taste, but your listening history is basically an empty chair.",
        summary: "Play more songs while signed in, then come back for judgment.",
        badges: ["Too mysterious"],
        tasteScore: 0,
        obscurityScore: 0,
        chaosScore: 0,
        generatedAt
      };
    }

    const promptPayload = {
      period,
      topTracks: topTracks.map((entry) => ({
        rank: entry.rank,
        title: entry.label,
        artist: entry.subtitle,
        plays: entry.playCount
      })),
      topArtists: topArtists.map((entry) => ({
        rank: entry.rank,
        artist: entry.label,
        plays: entry.playCount
      })),
      topGenres: topGenres.map((entry) => ({
        rank: entry.rank,
        genre: entry.label,
        plays: entry.playCount
      })),
      recent: recent.slice(0, 15).map((entry) => ({
        title: entry.title,
        artist: entry.artistName
      })),
      comparison: {
        obscurityScore: comparison.obscurityScore,
        mainstreamScore: comparison.mainstreamScore,
        uniquenessScore: comparison.uniquenessScore,
        overlapScore: comparison.overlapScore
      }
    };

    try {
      const response = await this.groqTasteService.chat(
        [
          {
            role: "system",
            content: [
              "You are WaveStack's playful music taste judge.",
              "Be funny, specific, and a little spicy, but not cruel.",
              "Do not mention Spotify.",
              "Do not mention Groq.",
              "Do not mention JSON, schema, API, parser, algorithm, or backend.",
              "Do not include markdown.",
              "Do not include code fences.",
              "Do not include labels like 'Verdict:', 'Roast:', 'Summary:', or 'Badges:' inside values.",
              "Return exactly one JSON object and nothing else.",
              "The JSON object must have these keys:",
              "verdictTitle, roast, summary, badges, tasteScore, obscurityScore, chaosScore.",
              "verdictTitle must be short and catchy.",
              "roast must be 1 to 2 fun sentences that describe the listener as a character shaped by their listening history.",
              "summary must be 1 friendly sentence.",
              "badges must be an array of 3 to 6 short fun labels.",
              "scores must be integers from 0 to 100.",
              stylePhrase ? `Write the roast and summary in this writing style: ${stylePhrase}.` : "",
              styleExample ? `Use this sample only as tone guidance, not as content to copy: ${styleExample}` : ""
            ].join(" ")
          },
          {
            role: "user",
            content: `Judge this WaveStack listening profile:\n${JSON.stringify(promptPayload, null, 2)}`
          }
        ],
        {
          maxTokens: 450,
          temperature: 0.55,
          timeoutMs: 45000
        }
      );

      const parsed = this.parseTasteJudgeJson(response, comparison);

      return {
        ...parsed,
        ok: true,
        generatedAt
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`judgeTaste failed: ${message}`);

      const dbHint = message.includes("column") || message.includes("relation")
        ? " (possible database schema mismatch — try clearing cache or running migrations)"
        : "";

      return {
        ok: false,
        verdictTitle: "Judge failed to load",
        roast: "The judge walked on stage, looked at the API keys, and left.",
        summary: message + dbHint,
        badges: ["API issue", "Try again", "Check server logs"],
        tasteScore: 0,
        obscurityScore: comparison.obscurityScore,
        chaosScore: comparison.uniquenessScore,
        generatedAt
      };
    }
  }

  async tasteComparison(userId: string, period = "ALL_TIME"): Promise<TasteComparisonResult> {
    const periodWhere = this.statsPeriodWhere(period);

    const userPlayCountResult = await this.database.query(
      `SELECT COUNT(*)::int AS count
       FROM app_listening_events e
       WHERE e.user_id = $1 ${periodWhere}`,
      [userId]
    );

    const libraryUserCountResult = await this.database.query(
      `SELECT COUNT(DISTINCT user_id)::int AS count
       FROM app_listening_events`
    );

    const rareArtistsResult = await this.database.query(
      `WITH user_artists AS (
         SELECT
           lower(COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')) AS artist_key,
           COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist') AS artist_name,
           COUNT(*)::int AS user_plays,
           COALESCE(SUM(e.duration_seconds), 0)::float8 AS total_duration_seconds
         FROM app_listening_events e
         WHERE e.user_id = $1 ${periodWhere}
         GROUP BY lower(COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')), COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')
       ),
       global_artists AS (
         SELECT
           lower(COALESCE(NULLIF(artist_name, ''), 'Unknown Artist')) AS artist_key,
           COUNT(DISTINCT user_id)::int AS listener_count,
           COUNT(*)::int AS global_plays
         FROM app_listening_events
         GROUP BY lower(COALESCE(NULLIF(artist_name, ''), 'Unknown Artist'))
       )
       SELECT
         ua.artist_key AS key,
         ua.artist_name AS label,
         ga.listener_count::text || ' listener(s) in WaveStack' AS subtitle,
         ROW_NUMBER() OVER (ORDER BY ga.listener_count ASC, ua.user_plays DESC, ua.artist_name ASC)::int AS rank,
         0 AS previous_rank,
         0 AS rank_change,
         ua.user_plays AS play_count,
         ua.total_duration_seconds,
         NULL::text AS song_id,
         NULL::text AS thumbnail_url
       FROM user_artists ua
       INNER JOIN global_artists ga ON ga.artist_key = ua.artist_key
       ORDER BY ga.listener_count ASC, ua.user_plays DESC, ua.artist_name ASC
       LIMIT 10`,
      [userId]
    );

    const commonArtistsResult = await this.database.query(
      `WITH user_artists AS (
         SELECT
           lower(COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')) AS artist_key,
           COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist') AS artist_name,
           COUNT(*)::int AS user_plays,
           COALESCE(SUM(e.duration_seconds), 0)::float8 AS total_duration_seconds
         FROM app_listening_events e
         WHERE e.user_id = $1 ${periodWhere}
         GROUP BY lower(COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')), COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')
       ),
       global_artists AS (
         SELECT
           lower(COALESCE(NULLIF(artist_name, ''), 'Unknown Artist')) AS artist_key,
           COUNT(DISTINCT user_id)::int AS listener_count,
           COUNT(*)::int AS global_plays
         FROM app_listening_events
         GROUP BY lower(COALESCE(NULLIF(artist_name, ''), 'Unknown Artist'))
       )
       SELECT
         ua.artist_key AS key,
         ua.artist_name AS label,
         ga.listener_count::text || ' listener(s) in WaveStack' AS subtitle,
         ROW_NUMBER() OVER (ORDER BY ga.listener_count DESC, ua.user_plays DESC, ua.artist_name ASC)::int AS rank,
         0 AS previous_rank,
         0 AS rank_change,
         ua.user_plays AS play_count,
         ua.total_duration_seconds,
         NULL::text AS song_id,
         NULL::text AS thumbnail_url
       FROM user_artists ua
       INNER JOIN global_artists ga ON ga.artist_key = ua.artist_key
       ORDER BY ga.listener_count DESC, ua.user_plays DESC, ua.artist_name ASC
       LIMIT 10`,
      [userId]
    );

    const userPlayCount = Number((this.rows(userPlayCountResult)[0] as { count?: number })?.count ?? 0);
    const libraryUserCount = Number((this.rows(libraryUserCountResult)[0] as { count?: number })?.count ?? 0);

    const rareArtists = this.mapStatsEntries(this.rows(rareArtistsResult) as StatsEntryRow[]);
    const commonArtists = this.mapStatsEntries(this.rows(commonArtistsResult) as StatsEntryRow[]);

    const artistDistributionResult = await this.database.query(
      `
      WITH user_artists AS (
        SELECT
          lower(COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')) AS artist_key,
          COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist') AS artist_name,
          COUNT(*)::int AS user_plays
        FROM app_listening_events e
        WHERE e.user_id = $1
          ${periodWhere}
        GROUP BY
          lower(COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')),
          COALESCE(NULLIF(e.artist_name, ''), 'Unknown Artist')
      ),
      global_artists AS (
        SELECT
          lower(COALESCE(NULLIF(artist_name, ''), 'Unknown Artist')) AS artist_key,
          COUNT(DISTINCT user_id)::int AS listener_count,
          COUNT(*)::int AS global_plays
        FROM app_listening_events
        GROUP BY lower(COALESCE(NULLIF(artist_name, ''), 'Unknown Artist'))
      )
      SELECT
        ua.artist_key,
        ua.artist_name,
        ua.user_plays,
        ga.listener_count,
        ga.global_plays
      FROM user_artists ua
      INNER JOIN global_artists ga ON ga.artist_key = ua.artist_key
      `,
      [userId]
    );

    const artistDistribution = this.rows(artistDistributionResult) as Array<{
      artist_key: string;
      artist_name: string;
      user_plays: string | number;
      listener_count: string | number;
      global_plays: string | number;
    }>;

    const totalUserArtistPlays = Math.max(
      1,
      artistDistribution.reduce((sum, row) => sum + Number(row.user_plays), 0)
    );

    const safeLibraryUserCount = Math.max(1, libraryUserCount);

    let weightedListenerReach = 0;
    let weightedSoloArtistPlays = 0;
    let weightedSharedArtistPlays = 0;
    let weightedGlobalPlayShare = 0;

    for (const row of artistDistribution) {
      const userPlays = Number(row.user_plays);
      const listenerCount = Number(row.listener_count);
      const globalPlays = Number(row.global_plays);
      const playWeight = userPlays / totalUserArtistPlays;

      const listenerReach = Math.max(0, Math.min(1, listenerCount / safeLibraryUserCount));
      const globalPlayShare = Math.max(0, Math.min(1, globalPlays / Math.max(1, userPlayCount + globalPlays)));

      weightedListenerReach += playWeight * listenerReach;
      weightedGlobalPlayShare += playWeight * globalPlayShare;

      if (listenerCount <= 1) {
        weightedSoloArtistPlays += playWeight;
      } else {
        weightedSharedArtistPlays += playWeight;
      }
    }

    const mainstreamScore = Math.max(0, Math.min(100, Math.round(weightedListenerReach * 100)));
    const obscurityScore = 100 - mainstreamScore;

    const uniquenessScore = Math.max(0, Math.min(100, Math.round(weightedSoloArtistPlays * 100)));
    const overlapScore = Math.max(0, Math.min(100, Math.round(weightedSharedArtistPlays * 100)));

    return {
      userPlayCount,
      libraryUserCount,
      obscurityScore,
      mainstreamScore,
      uniquenessScore,
      overlapScore,
      rareArtists,
      commonArtists
    };
  }

  private parseTasteJudgeJson(raw: string, comparison: TasteComparisonResult): Omit<TasteJudgeResult, "ok" | "generatedAt"> {
    const cleanedText = this.cleanJudgeText(raw);

    const fallback = {
      verdictTitle: "Chaotic but committed",
      roast: this.toFriendlyRoast(cleanedText),
      summary: "Your taste has range, drama, and enough left turns to keep WaveStack awake.",
      badges: ["Deep cuts", "Vibe hopper", "Aux risk"],
      tasteScore: Math.max(0, Math.min(100, 100 - comparison.mainstreamScore + 30)),
      obscurityScore: comparison.obscurityScore,
      chaosScore: Math.max(0, Math.min(100, comparison.uniquenessScore + 20))
    };

    const jsonCandidate = this.extractJsonObject(raw);

    if (!jsonCandidate) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(jsonCandidate) as Partial<{
        verdictTitle: unknown;
        roast: unknown;
        summary: unknown;
        badges: unknown;
        tasteScore: unknown;
        obscurityScore: unknown;
        chaosScore: unknown;
      }>;

      return {
        verdictTitle: this.cleanJudgeText(String(parsed.verdictTitle || fallback.verdictTitle)).slice(0, 90),
        roast: this.cleanJudgeText(String(parsed.roast || fallback.roast)).slice(0, 420),
        summary: this.cleanJudgeText(String(parsed.summary || fallback.summary)).slice(0, 260),
        badges: this.normalizeJudgeBadges(parsed.badges, fallback.badges),
        tasteScore: this.clampScore(parsed.tasteScore, fallback.tasteScore),
        obscurityScore: this.clampScore(parsed.obscurityScore, comparison.obscurityScore),
        chaosScore: this.clampScore(parsed.chaosScore, fallback.chaosScore)
      };
    } catch {
      return fallback;
    }
  }

  private extractJsonObject(raw: string): string | null {
    const text = raw.trim();

    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

    if (fencedMatch?.[1]) {
      const fenced = fencedMatch[1].trim();
      const firstBrace = fenced.indexOf("{");
      const lastBrace = fenced.lastIndexOf("}");

      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return fenced.slice(firstBrace, lastBrace + 1);
      }
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1);
    }

    return null;
  }

  private cleanJudgeText(value: string): string {
    return value
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .replace(/\bVerdict:\s*/gi, "")
      .replace(/\bRoast:\s*/gi, "")
      .replace(/\bSummary:\s*/gi, "")
      .replace(/\bBadges:\s*/gi, "")
      .replace(/\bTaste Score:\s*\d+\s*(?:\(out of 100\))?/gi, "")
      .replace(/\bObscurity Score:\s*\d+\s*(?:\(out of 100\))?/gi, "")
      .replace(/\bChaos Score:\s*\d+\s*(?:\(out of 100\))?/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private toFriendlyRoast(raw: string): string {
    const cleaned = this.cleanJudgeText(raw);

    if (!cleaned) {
      return "Your library is giving mysterious main character energy with a side of playlist goblin.";
    }

    const withoutJson = cleaned.replace(/\{[\s\S]*\}/g, "").trim();

    if (!withoutJson) {
      return "Your library is giving mysterious main character energy with a side of playlist goblin.";
    }

    return withoutJson.slice(0, 360);
  }

  private normalizeJudgeBadges(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const badges = value
      .map((item) => this.cleanJudgeText(String(item)))
      .map((item) => item.replace(/^[-•]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 6);

    return badges.length ? badges : fallback;
  }

  private clampScore(value: unknown, fallback: number): number {
    const numberValue = Number(value);

    if (!Number.isFinite(numberValue)) {
      return fallback;
    }

    return Math.max(0, Math.min(100, Math.round(numberValue)));
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

function stableSongScore(value: string): number {
  let hash = 0;

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return (hash % 1000) / 1000;
}
