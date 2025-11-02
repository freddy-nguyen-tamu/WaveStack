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

  async recommendSongs(userId: string | null, limit = 24): Promise<RecommendSongResult[]> {
    const allSongs = await this.musicService.dashboardSongs(Math.max(limit * 3, 80));

    if (!allSongs.length) {
      return [];
    }

    const shuffled = [...allSongs].sort(() => Math.random() - 0.5);

    if (!userId) {
      return shuffled.slice(0, limit).map((song) => ({
        song,
        reason: "Random pick"
      }));
    }

    const result = await this.database.query(
      `SELECT song_id, COUNT(*) AS play_count
       FROM app_listening_events
       WHERE user_id = $1
       GROUP BY song_id
       ORDER BY play_count DESC`,
      [userId]
    );

    const rows = this.rows(result) as PlayCountRow[];
    const playCounts = new Map<string, number>();

    for (const row of rows) {
      playCounts.set(row.song_id, Number(row.play_count));
    }

    if (playCounts.size === 0) {
      return shuffled.slice(0, limit).map((song) => ({
        song,
        reason: "Random pick (no listening history yet)"
      }));
    }

    const scored: Array<{ song: Song; score: number; reason: string }> = [];

    for (const song of allSongs) {
      const playCount = playCounts.get(song.id) ?? 0;

      if (playCount > 0) {
        scored.push({
          song,
          score: playCount * 10 + Math.random(),
          reason: `Played ${playCount} time(s)`
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    if (scored.length < limit) {
      const existingIds = new Set(scored.map((item) => item.song.id));
      const discovery = shuffled.filter((song) => !existingIds.has(song.id));

      for (const song of discovery) {
        if (scored.length >= limit) {
          break;
        }

        scored.push({
          song,
          score: Math.random(),
          reason: "Discovery"
        });
      }
    }

    return scored.slice(0, limit).map(({ song, reason }) => ({ song, reason }));
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
