import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  ArchivedListeningEvent,
  DrivePrivateExportService
} from "./drive-private-export.service";
import {
  ListeningArchiveResult,
  ListeningArchiveStatus
} from "./habits.models";

type QueryResultRow = Record<string, unknown>;
type QueryResultLike = { rows: QueryResultRow[] } | QueryResultRow[];

type ArchiveCandidateRow = {
  id?: string;
  user_id: string;
  email: string;
  display_name: string;
  song_id: string;
  artist_name: string;
  title: string;
  duration_seconds: string | number;
  completed_play_ratio: string | number;
  started_at: Date | string;
};

type RollupRow = {
  user_id: string;
  email: string;
  display_name: string;
  month_start: Date | string;
  song_id: string;
  artist_name: string;
  title: string;
  play_count: string | number;
  total_duration_seconds: string | number;
};

type ArchiveRunRow = {
  id: string;
};

type ArchiveStatusRow = {
  raw_event_count: string | number;
  archived_rollup_row_count: string | number;
  archive_run_count: string | number;
  oldest_raw_event_at?: Date | string | null;
  latest_archive_run_at?: Date | string | null;
  latest_archive_status?: string | null;
  latest_archive_message?: string | null;
};

@Injectable()
export class ListeningArchiveService {
  private readonly logger = new Logger(ListeningArchiveService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly drivePrivateExport: DrivePrivateExportService
  ) {}

  async status(): Promise<ListeningArchiveStatus> {
    const result = await this.database.query(
      `WITH event_stats AS (
        SELECT
          COUNT(*)::int AS raw_event_count,
          MIN(started_at) AS oldest_raw_event_at
        FROM app_listening_events
      ),
      rollup_stats AS (
        SELECT COUNT(*)::int AS archived_rollup_row_count
        FROM app_listening_monthly_rollups
      ),
      run_stats AS (
        SELECT
          COUNT(*)::int AS archive_run_count,
          MAX(started_at) AS latest_archive_run_at
        FROM app_listening_event_archive_runs
      ),
      latest_run AS (
        SELECT status, error_message
        FROM app_listening_event_archive_runs
        ORDER BY started_at DESC
        LIMIT 1
      )
      SELECT
        event_stats.raw_event_count,
        event_stats.oldest_raw_event_at,
        rollup_stats.archived_rollup_row_count,
        run_stats.archive_run_count,
        run_stats.latest_archive_run_at,
        latest_run.status AS latest_archive_status,
        latest_run.error_message AS latest_archive_message
      FROM event_stats
      CROSS JOIN rollup_stats
      CROSS JOIN run_stats
      LEFT JOIN latest_run ON true`
    );

    const row = this.rows<ArchiveStatusRow>(result)[0];

    return {
      rawEventCount: Number(row?.raw_event_count ?? 0),
      archivedRollupRowCount: Number(row?.archived_rollup_row_count ?? 0),
      archiveRunCount: Number(row?.archive_run_count ?? 0),
      oldestRawEventAt: this.isoOrUndefined(row?.oldest_raw_event_at),
      latestArchiveRunAt: this.isoOrUndefined(row?.latest_archive_run_at),
      latestArchiveStatus: row?.latest_archive_status ?? undefined,
      latestArchiveMessage: row?.latest_archive_message ?? undefined
    };
  }

  async archiveOldEvents(options: {
    daysToKeep: number;
    dryRun: boolean;
    batchLimit?: number;
  }): Promise<ListeningArchiveResult> {
    const daysToKeep = Math.max(30, Math.min(options.daysToKeep, 3650));
    const batchLimit = Math.max(100, Math.min(options.batchLimit ?? 5000, 20000));
    const dryRun = options.dryRun;
    const cutoffAt = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const runResult = await this.database.query(
      `INSERT INTO app_listening_event_archive_runs (cutoff_at, dry_run, status)
       VALUES ($1, $2, 'running')
       RETURNING id`,
      [cutoffAt.toISOString(), dryRun]
    );

    const runId = this.rows<ArchiveRunRow>(runResult)[0]?.id;

    try {
      const candidateResult = await this.database.query(
        `SELECT
          e.id,
          e.user_id,
          u.email,
          u.display_name,
          e.song_id,
          e.artist_name,
          e.title,
          e.duration_seconds,
          e.completed_play_ratio,
          e.started_at
         FROM app_listening_events e
         INNER JOIN app_users u ON u.id = e.user_id
         WHERE e.started_at < $1
         ORDER BY e.user_id ASC, e.started_at ASC
         LIMIT $2`,
        [cutoffAt.toISOString(), batchLimit]
      );

      const candidates = this.rows<ArchiveCandidateRow>(candidateResult);

      if (!candidates.length) {
        await this.finishRun(runId, {
          status: "success",
          exportedEventCount: 0,
          deletedEventCount: 0,
          driveFileCount: 0,
          errorMessage: null
        });

        return {
          ok: true,
          message: `No listening events older than ${daysToKeep} day(s) need archiving.`,
          exportedEventCount: 0,
          deletedEventCount: 0,
          driveFileCount: 0,
          cutoffAt: cutoffAt.toISOString(),
          runId
        };
      }

      await this.upsertMonthlyRollups(candidates);

      const groups = this.groupEventsByUserAndDay(candidates);
      let exportedEventCount = 0;
      let driveFileCount = 0;
      let firstDriveFolderId: string | undefined;

      for (const group of groups) {
        if (!dryRun) {
          const writeResult = await this.drivePrivateExport.writeListeningArchiveFile({
            userId: group.userId,
            userEmail: group.userEmail,
            displayName: group.displayName,
            archiveDate: group.archiveDate,
            events: group.events
          });

          if (!writeResult.ok) {
            throw new Error(writeResult.message);
          }

          firstDriveFolderId = firstDriveFolderId ?? writeResult.folderId;
        }

        exportedEventCount += group.events.length;
        driveFileCount += 1;
      }

      await this.writeMonthlyRollupFiles(candidates, dryRun);

      let deletedEventCount = 0;

      if (!dryRun) {
        const ids = candidates.map((row) => row.id).filter(Boolean);

        if (ids.length) {
          const deleteResult = await this.database.query(
            `DELETE FROM app_listening_events
             WHERE id = ANY($1::uuid[])`,
            [ids]
          );

          deletedEventCount = this.rowCount(deleteResult);
        }
      }

      await this.finishRun(runId, {
        status: "success",
        exportedEventCount,
        deletedEventCount,
        driveFileCount: dryRun ? 0 : driveFileCount,
        driveFolderId: firstDriveFolderId,
        errorMessage: null
      });

      return {
        ok: true,
        message: dryRun
          ? `Dry run found ${exportedEventCount} old listening event(s) that would be archived.`
          : `Archived ${exportedEventCount} listening event(s) into ${driveFileCount} Drive file(s), then deleted ${deletedEventCount} raw row(s) from Postgres.`,
        exportedEventCount,
        deletedEventCount,
        driveFileCount: dryRun ? 0 : driveFileCount,
        cutoffAt: cutoffAt.toISOString(),
        driveFolderId: firstDriveFolderId,
        runId
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Listening archive failed: ${message}`);

      await this.finishRun(runId, {
        status: "failed",
        exportedEventCount: 0,
        deletedEventCount: 0,
        driveFileCount: 0,
        errorMessage: message
      });

      return {
        ok: false,
        message,
        exportedEventCount: 0,
        deletedEventCount: 0,
        driveFileCount: 0,
        cutoffAt: cutoffAt.toISOString(),
        runId,
        errorMessage: message
      };
    }
  }

  private async upsertMonthlyRollups(rows: ArchiveCandidateRow[]): Promise<void> {
    for (const row of rows) {
      const startedAt = new Date(row.started_at);
      const monthStart = `${startedAt.getUTCFullYear()}-${String(startedAt.getUTCMonth() + 1).padStart(2, "0")}-01`;

      await this.database.query(
        `INSERT INTO app_listening_monthly_rollups (
          user_id, month_start, song_id, artist_name, title,
          play_count, total_duration_seconds, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, 1, $6, now())
        ON CONFLICT (user_id, month_start, song_id)
        DO UPDATE SET
          play_count = app_listening_monthly_rollups.play_count + 1,
          total_duration_seconds = app_listening_monthly_rollups.total_duration_seconds + EXCLUDED.total_duration_seconds,
          artist_name = EXCLUDED.artist_name,
          title = EXCLUDED.title,
          updated_at = now()`,
        [
          row.user_id,
          monthStart,
          row.song_id,
          row.artist_name || "Unknown Artist",
          row.title || "Unknown Track",
          Math.round(Number(row.duration_seconds) || 0)
        ]
      );
    }
  }

  private async writeMonthlyRollupFiles(rows: ArchiveCandidateRow[], dryRun: boolean): Promise<void> {
    if (dryRun) {
      return;
    }

    const usersAndMonths = new Map<string, {
      userId: string;
      userEmail: string;
      displayName: string;
      monthStart: string;
    }>();

    for (const row of rows) {
      const startedAt = new Date(row.started_at);
      const monthStart = `${startedAt.getUTCFullYear()}-${String(startedAt.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const key = `${row.user_id}:${monthStart}`;

      usersAndMonths.set(key, {
        userId: row.user_id,
        userEmail: row.email,
        displayName: row.display_name,
        monthStart
      });
    }

    for (const item of usersAndMonths.values()) {
      const rollupResult = await this.database.query(
        `SELECT
          song_id,
          artist_name,
          title,
          play_count,
          total_duration_seconds
         FROM app_listening_monthly_rollups
         WHERE user_id = $1 AND month_start = $2
         ORDER BY play_count DESC, total_duration_seconds DESC, title ASC`,
        [item.userId, item.monthStart]
      );

      const rollupRows = this.rows<RollupRow>(rollupResult).map((row) => ({
        songId: row.song_id,
        artistName: row.artist_name,
        title: row.title,
        playCount: Number(row.play_count),
        totalDurationSeconds: Number(row.total_duration_seconds)
      }));

      const result = await this.drivePrivateExport.writeListeningRollupFile({
        userId: item.userId,
        userEmail: item.userEmail,
        displayName: item.displayName,
        monthStart: item.monthStart,
        rows: rollupRows
      });

      if (!result.ok) {
        throw new Error(result.message);
      }
    }
  }

  private groupEventsByUserAndDay(rows: ArchiveCandidateRow[]): Array<{
    userId: string;
    userEmail: string;
    displayName: string;
    archiveDate: string;
    events: ArchivedListeningEvent[];
  }> {
    const groups = new Map<string, {
      userId: string;
      userEmail: string;
      displayName: string;
      archiveDate: string;
      events: ArchivedListeningEvent[];
    }>();

    for (const row of rows) {
      const startedAt = new Date(row.started_at);
      const archiveDate = startedAt.toISOString().slice(0, 10);
      const key = `${row.user_id}:${archiveDate}`;

      if (!groups.has(key)) {
        groups.set(key, {
          userId: row.user_id,
          userEmail: row.email,
          displayName: row.display_name,
          archiveDate,
          events: []
        });
      }

      groups.get(key)?.events.push({
        id: row.id,
        userId: row.user_id,
        userEmail: row.email,
        displayName: row.display_name,
        songId: row.song_id,
        artistName: row.artist_name || "Unknown Artist",
        title: row.title || "Unknown Track",
        durationSeconds: Number(row.duration_seconds) || 0,
        completedPlayRatio: Number(row.completed_play_ratio) || 0,
        startedAt: this.isoOrUndefined(row.started_at) ?? new Date().toISOString()
      });
    }

    return Array.from(groups.values());
  }

  private async finishRun(runId: string | undefined, values: {
    status: string;
    exportedEventCount: number;
    deletedEventCount: number;
    driveFileCount: number;
    driveFolderId?: string;
    errorMessage: string | null;
  }): Promise<void> {
    if (!runId) {
      return;
    }

    await this.database.query(
      `UPDATE app_listening_event_archive_runs
       SET finished_at = now(),
           status = $2,
           exported_event_count = $3,
           deleted_event_count = $4,
           drive_file_count = $5,
           drive_folder_id = $6,
           error_message = $7
       WHERE id = $1`,
      [
        runId,
        values.status,
        values.exportedEventCount,
        values.deletedEventCount,
        values.driveFileCount,
        values.driveFolderId ?? null,
        values.errorMessage
      ]
    );
  }

  private rows<T>(result: QueryResultLike): T[] {
    const items = Array.isArray(result) ? result : result.rows;
    return items as T[];
  }

  private rowCount(result: unknown): number {
    if (result && typeof result === "object" && "rowCount" in result) {
      return Number((result as { rowCount?: number }).rowCount ?? 0);
    }

    return 0;
  }

  private isoOrUndefined(value: Date | string | null | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}
