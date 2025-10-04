import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DatabaseService } from "../database/database.service";
import { MusicService } from "../music/music.service";
import { Song } from "../music/music.models";
import { HabitSummaryEntry, RecommendSongResult } from "./habits.models";

@Injectable()
export class HabitsService {
  private readonly logger = new Logger(HabitsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly musicService: MusicService,
    private readonly config: ConfigService
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
    const allSongs = await this.musicService.listSongs();

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

    const rows = await this.database.query(
      `SELECT song_id, COUNT(*) as play_count
       FROM app_listening_events
       WHERE user_id = $1
       GROUP BY song_id
       ORDER BY play_count DESC`,
      [userId]
    );

    const playCounts = new Map<string, number>();

    for (const row of rows as Array<{ song_id: string; play_count: number }>) {
      playCounts.set(row.song_id, row.play_count);
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
        if (scored.length >= limit) break;
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
    const intervalMap: Record<string, string> = {
      DAY: "interval '24 hours'",
      WEEK: "interval '7 days'",
      MONTH: "interval '30 days'",
      YEAR: "interval '365 days'"
    };

    const interval = intervalMap[period] ?? "interval '7 days'";

    const rows = await this.database.query(
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

    return (rows as Array<{ label: string; count: number; total_duration_seconds: number }>).map(
      (row) => ({
        label: row.label,
        count: row.count,
        totalDurationSeconds: row.total_duration_seconds
      })
    );
  }

  async exportToDrive(userId: string): Promise<boolean> {
    const folderId = this.config.get<string>("LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID");

    if (!folderId || folderId === "TODO_FILL_LATER") {
      this.logger.warn("LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID not set; export skipped.");
      return false;
    }

    this.logger.log(`Export listening habits to Drive folder ${folderId} for user ${userId}: not yet implemented.`);
    return false;
  }
}
