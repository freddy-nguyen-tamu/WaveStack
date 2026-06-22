import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
export class ListeningArchiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ListeningArchiveService.name);
  private dailyArchiveTimeout?: ReturnType<typeof setTimeout>;
  private dailyArchiveInterval?: ReturnType<typeof setInterval>;
  private dailyArchiveRunning = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly drivePrivateExport: DrivePrivateExportService,
    private readonly config: ConfigService
  ) {}

  onModuleInit(): void {
    this.scheduleDailyColdStorage();
  }

  onModuleDestroy(): void {
    if (this.dailyArchiveTimeout) {
      clearTimeout(this.dailyArchiveTimeout);
    }

    if (this.dailyArchiveInterval) {
      clearInterval(this.dailyArchiveInterval);
    }
  }

  async status(userId?: string): Promise<ListeningArchiveStatus> {
    const result = await this.database.query(
      `WITH event_stats AS (
        SELECT
          COUNT(*)::int AS raw_event_count,
          MIN(started_at) AS oldest_raw_event_at
        FROM app_listening_events
        WHERE ($1::uuid IS NULL OR user_id = $1::uuid)
      ),
      rollup_stats AS (
        SELECT COUNT(*)::int AS archived_rollup_row_count
        FROM app_listening_monthly_rollups
        WHERE ($1::uuid IS NULL OR user_id = $1::uuid)
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
      LEFT JOIN latest_run ON true`,
      [userId ?? null]
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
    userId?: string;
    daysToKeep: number;
    dryRun: boolean;
    batchLimit?: number;
  }): Promise<ListeningArchiveResult> {
    const daysToKeep = Math.max(1, Math.min(options.daysToKeep, 3650));
    const batchLimit = Math.max(100, Math.min(options.batchLimit ?? 5000, 20000));
    const dryRun = options.dryRun;
    const cutoffAt = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const userId = options.userId ?? null;

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
           AND ($3::uuid IS NULL OR e.user_id = $3::uuid)
         ORDER BY e.user_id ASC, e.started_at ASC
         LIMIT $2`,
        [cutoffAt.toISOString(), batchLimit, userId]
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

      const userTokens = await this.getUserRefreshTokens(candidates);
      const groups = this.groupEventsByUserAndDay(candidates);
      let exportedEventCount = 0;
      let driveFileCount = 0;
      let firstDriveFolderId: string | undefined;
      const archivedEventIds: string[] = [];

      for (const group of groups) {
        const refreshToken = userTokens.get(group.userId);

        if (!refreshToken) {
          this.logger.warn(`No google_refresh_token for user ${group.userId}, skipping Drive write`);
          continue;
        }

        if (!dryRun) {
          const writeResult = await this.drivePrivateExport.writeListeningArchiveFileAsUser(
            {
              userId: group.userId,
              userEmail: group.userEmail,
              displayName: group.displayName,
              archiveDate: group.archiveDate,
              events: group.events
            },
            refreshToken
          );

          if (!writeResult.ok) {
            throw new Error(writeResult.message);
          }

          firstDriveFolderId = firstDriveFolderId ?? writeResult.folderId;

          if (writeResult.fileId) {
            const date = new Date(`${group.archiveDate}T00:00:00.000Z`);
            const archiveYear = date.getUTCFullYear();
            const archiveMonth = date.getUTCMonth() + 1;

            await this.database.query(
              `INSERT INTO app_listening_archive_files (
                user_id, archive_date, archive_year, archive_month,
                drive_file_id, drive_folder_id, file_name, event_count,
                web_view_link, cache_status, exported_at, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'not_cached', now(), now())
              ON CONFLICT (user_id, archive_date) DO UPDATE SET
                drive_file_id = EXCLUDED.drive_file_id,
                drive_folder_id = EXCLUDED.drive_folder_id,
                file_name = EXCLUDED.file_name,
                event_count = EXCLUDED.event_count,
                web_view_link = EXCLUDED.web_view_link,
                cache_status = 'not_cached',
                updated_at = now()`,
              [
                group.userId,
                group.archiveDate,
                archiveYear,
                archiveMonth,
                writeResult.fileId,
                writeResult.folderId ?? null,
                `listening-events-${group.archiveDate}.jsonl`,
                group.events.length,
                writeResult.webViewLink ?? null
              ]
            );

            archivedEventIds.push(
              ...group.events
                .map((event) => event.id)
                .filter((id): id is string => Boolean(id))
            );
          }
        }

        exportedEventCount += group.events.length;
        driveFileCount += 1;
      }

      await this.writeMonthlyRollupFiles(candidates, dryRun, userTokens);

      let deletedEventCount = 0;
      const deleteAfterExport = this.boolEnv("LISTENING_ARCHIVE_DELETE_AFTER_EXPORT", false);

      if (!dryRun && deleteAfterExport && archivedEventIds.length > 0) {
        const deleteResult = await this.database.query(
          `DELETE FROM app_listening_events
           WHERE id = ANY($1::uuid[])`,
          [archivedEventIds]
        );
        deletedEventCount = this.rowCount(deleteResult);
      }

      if (!dryRun && !deleteAfterExport && archivedEventIds.length > 0) {
        this.logger.warn(
          `Archive export succeeded for ${archivedEventIds.length} event(s), but LISTENING_ARCHIVE_DELETE_AFTER_EXPORT=false so hot rows were kept.`
        );
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

  private scheduleDailyColdStorage(): void {
    const enabled = (this.config.get<string>("LISTENING_ARCHIVE_DAILY_ENABLED") ?? "true").toLowerCase() !== "false";

    if (!enabled) {
      this.logger.log("Daily listening cold storage is disabled.");
      return;
    }

    const utcHour = Math.max(0, Math.min(Number(this.config.get<string>("LISTENING_ARCHIVE_DAILY_UTC_HOUR") ?? 7), 23));
    const delay = this.nextUtcHourDelay(utcHour);

    this.dailyArchiveTimeout = setTimeout(() => {
      void this.runDailyColdStorage();
      this.dailyArchiveInterval = setInterval(() => {
        void this.runDailyColdStorage();
      }, 24 * 60 * 60 * 1000);
    }, delay);

    this.logger.log(`Daily listening cold storage scheduled for ${utcHour}:00 UTC.`);
  }

  private async runDailyColdStorage(): Promise<void> {
    if (this.dailyArchiveRunning) {
      return;
    }

    this.dailyArchiveRunning = true;

    try {
      const daysToKeep = Number(this.config.get<string>("LISTENING_ARCHIVE_DAILY_DAYS_TO_KEEP") ?? 1);
      const result = await this.archiveOldEvents({
        daysToKeep,
        dryRun: false,
        batchLimit: 20000
      });

      if (result.ok) {
        this.logger.log(result.message);
      } else {
        this.logger.warn(result.message);
      }
    } finally {
      this.dailyArchiveRunning = false;
    }
  }

  private nextUtcHourDelay(utcHour: number): number {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(utcHour, 0, 0, 0);

    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    return next.getTime() - now.getTime();
  }

  private async getUserRefreshTokens(rows: ArchiveCandidateRow[]): Promise<Map<string, string>> {
    const userIds = Array.from(new Set(rows.map((r) => r.user_id)));

    if (!userIds.length) {
      return new Map();
    }

    const result = await this.database.query(
      `SELECT id, google_refresh_token
       FROM app_users
       WHERE id = ANY($1::uuid[])`,
      [userIds]
    );

    const rawRows = this.rows<{ id: string; google_refresh_token: string | null }>(result);
    const map = new Map<string, string>();

    for (const row of rawRows) {
      if (row.google_refresh_token) {
        map.set(row.id, row.google_refresh_token);
      }
    }

    return map;
  }

  private async writeMonthlyRollupFiles(
    rows: ArchiveCandidateRow[],
    dryRun: boolean,
    userTokens: Map<string, string>
  ): Promise<void> {
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
      const refreshToken = userTokens.get(item.userId);

      if (!refreshToken) {
        this.logger.warn(`No google_refresh_token for user ${item.userId}, skipping rollup file`);
        continue;
      }

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

      const result = await this.drivePrivateExport.writeListeningRollupFileAsUser(
        {
          userId: item.userId,
          userEmail: item.userEmail,
          displayName: item.displayName,
          monthStart: item.monthStart,
          rows: rollupRows
        },
        refreshToken
      );

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

  async warmArchiveCacheForRange(options: {
    userId: string;
    from: Date;
    to: Date;
    force?: boolean;
  }): Promise<{
    ok: boolean;
    message: string;
    filesScanned: number;
    filesRead: number;
    eventsCached: number;
    skippedFiles: number;
    errors: string[];
  }> {
    const readThroughEnabled = this.boolEnv("LISTENING_ARCHIVE_READ_THROUGH_ENABLED", false);
    if (!readThroughEnabled) {
      return { ok: true, message: "Read-through disabled", filesScanned: 0, filesRead: 0, eventsCached: 0, skippedFiles: 0, errors: [] };
    }

    const restoreCacheEnabled = this.boolEnv("LISTENING_ARCHIVE_RESTORE_CACHE_ENABLED", true);
    if (!restoreCacheEnabled) {
      return { ok: true, message: "Restore cache disabled", filesScanned: 0, filesRead: 0, eventsCached: 0, skippedFiles: 0, errors: [] };
    }

    const errors: string[] = [];
    let filesScanned = 0;
    let filesRead = 0;
    let eventsCached = 0;
    let skippedFiles = 0;

    try {
      const userResult = await this.database.query(
        `SELECT google_refresh_token FROM app_users WHERE id = $1`,
        [options.userId]
      );
      const userRow = this.rows<{ google_refresh_token: string | null }>(userResult)[0];
      if (!userRow?.google_refresh_token) {
        return { ok: false, message: "No Google refresh token for user", filesScanned: 0, filesRead: 0, eventsCached: 0, skippedFiles: 0, errors: [] };
      }

      const refreshToken = userRow.google_refresh_token;
      const fromStr = options.from.toISOString().slice(0, 10);
      const toStr = options.to.toISOString().slice(0, 10);
      const maxFiles = this.numberEnv("LISTENING_ARCHIVE_MAX_FILES_PER_READ", 36);

      const driveFiles = await this.drivePrivateExport.listListeningArchiveFilesAsUser(
        options.userId, refreshToken, fromStr, toStr
      );

      for (const driveFile of driveFiles) {
        filesScanned++;
        if (filesScanned > maxFiles) {
          skippedFiles += driveFiles.length - filesScanned + 1;
          break;
        }

        try {
          const existingResult = await this.database.query(
            `SELECT id, cache_status FROM app_listening_archive_files WHERE drive_file_id = $1`,
            [driveFile.fileId]
          );
          const existingRow = this.rows<{ id: string; cache_status: string }>(existingResult)[0];

          if (existingRow && existingRow.cache_status === "cached" && !options.force) {
            skippedFiles++;
            await this.database.query(
              `UPDATE app_listening_archive_files SET last_read_at = now() WHERE id = $1`,
              [existingRow.id]
            );
            continue;
          }

          const events = await this.drivePrivateExport.readListeningArchiveFileAsUser(refreshToken, driveFile.fileId);
          const validEvents = events.filter((e) => e.userId === options.userId);

          if (!validEvents.length) {
            skippedFiles++;
            continue;
          }

          let resolvedArchiveFileId: string | null = existingRow?.id ?? null;

          if (!resolvedArchiveFileId) {
            const insertResult = await this.database.query(
              `INSERT INTO app_listening_archive_files (
                user_id, archive_date, archive_year, archive_month,
                drive_file_id, drive_folder_id, file_name, event_count,
                cache_status, exported_at, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cached', now(), now())
              ON CONFLICT (user_id, archive_date) DO UPDATE SET
                drive_file_id = EXCLUDED.drive_file_id,
                drive_folder_id = EXCLUDED.drive_folder_id,
                file_name = EXCLUDED.file_name,
                event_count = EXCLUDED.event_count,
                cache_status = 'cached',
                cached_at = now(),
                last_read_at = now(),
                updated_at = now()
              RETURNING id`,
              [
                options.userId,
                driveFile.archiveDate,
                new Date(driveFile.archiveDate).getUTCFullYear(),
                new Date(driveFile.archiveDate).getUTCMonth() + 1,
                driveFile.fileId,
                "",
                driveFile.name,
                validEvents.length
              ]
            );
            const insertedArchiveFile = this.rows<{ id: string }>(insertResult)[0];
            resolvedArchiveFileId = insertedArchiveFile?.id ?? null;
          }

          if (!resolvedArchiveFileId) {
            skippedFiles++;
            continue;
          }

          let insertedCount = 0;
          for (const event of validEvents) {
            try {
              const originalEventId = event.id ?? null;

              const insertSql = originalEventId
                ? `INSERT INTO app_listening_archive_cached_events (
                    archive_file_id, original_event_id, user_id, song_id,
                    artist_name, title, duration_seconds, completed_play_ratio, started_at, cached_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
                  ON CONFLICT (user_id, original_event_id) WHERE original_event_id IS NOT NULL DO NOTHING`
                : `INSERT INTO app_listening_archive_cached_events (
                    archive_file_id, original_event_id, user_id, song_id,
                    artist_name, title, duration_seconds, completed_play_ratio, started_at, cached_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
                  ON CONFLICT (user_id, song_id, started_at) WHERE original_event_id IS NULL DO NOTHING`;

              const insertResult = await this.database.query(insertSql, [
                resolvedArchiveFileId,
                originalEventId,
                event.userId,
                event.songId,
                event.artistName ?? "Unknown Artist",
                event.title ?? "Unknown Track",
                event.durationSeconds ?? 0,
                event.completedPlayRatio ?? 0,
                event.startedAt
              ]);

              insertedCount += this.rowCount(insertResult);
            } catch (insertErr) {
              this.logger.warn(`Failed to cache event: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}`);
            }
          }

          eventsCached += insertedCount;
          filesRead++;

          await this.database.query(
            `UPDATE app_listening_archive_files
             SET cache_status = 'cached', cached_at = now(), last_read_at = now(), event_count = $2, updated_at = now()
             WHERE id = $1`,
            [resolvedArchiveFileId, validEvents.length]
          );
        } catch (fileErr) {
          const msg = `File ${driveFile.fileId}: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`;
          errors.push(msg);
          this.logger.error(msg);
        }
      }

      return {
        ok: true,
        message: `Warmed cache: ${filesRead} file(s) read, ${eventsCached} event(s) cached, ${skippedFiles} skipped`,
        filesScanned,
        filesRead,
        eventsCached,
        skippedFiles,
        errors
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(msg);
      return {
        ok: false,
        message: msg,
        filesScanned,
        filesRead,
        eventsCached,
        skippedFiles,
        errors
      };
    }
  }

  async getReadThroughStatus(userId: string): Promise<{
    readThroughEnabled: boolean;
    deleteAfterExport: boolean;
    rootFolderId?: string;
    rootFolderWebViewLink?: string;
    archiveFileCount: number;
    cachedArchiveFileCount: number;
    cachedEventCount: number;
    latestCachedAt?: string;
    latestReadAt?: string;
    message?: string;
  }> {
    const readThroughEnabled = this.boolEnv("LISTENING_ARCHIVE_READ_THROUGH_ENABLED", false);
    const deleteAfterExport = this.boolEnv("LISTENING_ARCHIVE_DELETE_AFTER_EXPORT", false);

    try {
      const rootResult = await this.database.query(
        `SELECT root_folder_id, root_folder_web_view_link
         FROM app_user_drive_archive_roots WHERE user_id = $1`,
        [userId]
      );
      const rootRow = this.rows<{ root_folder_id: string; root_folder_web_view_link?: string }>(rootResult)[0];

      const fileStatsResult = await this.database.query(
        `SELECT
          COUNT(*)::int AS archive_file_count,
          COUNT(*) FILTER (WHERE cache_status = 'cached')::int AS cached_file_count,
          MAX(cached_at) AS latest_cached_at,
          MAX(last_read_at) AS latest_read_at
         FROM app_listening_archive_files
         WHERE user_id = $1`,
        [userId]
      );
      const statsRow = this.rows<{
        archive_file_count: string | number;
        cached_file_count: string | number;
        latest_cached_at?: Date | string;
        latest_read_at?: Date | string;
      }>(fileStatsResult)[0];

      const cachedEventsResult = await this.database.query(
        `SELECT COUNT(*)::int AS cached_event_count
         FROM app_listening_archive_cached_events
         WHERE user_id = $1`,
        [userId]
      );
      const cachedEventsRow = this.rows<{ cached_event_count: string | number }>(cachedEventsResult)[0];

      return {
        readThroughEnabled,
        deleteAfterExport,
        rootFolderId: rootRow?.root_folder_id ?? undefined,
        rootFolderWebViewLink: rootRow?.root_folder_web_view_link ?? undefined,
        archiveFileCount: Number(statsRow?.archive_file_count ?? 0),
        cachedArchiveFileCount: Number(statsRow?.cached_file_count ?? 0),
        cachedEventCount: Number(cachedEventsRow?.cached_event_count ?? 0),
        latestCachedAt: statsRow?.latest_cached_at ? this.isoOrUndefined(statsRow.latest_cached_at) : undefined,
        latestReadAt: statsRow?.latest_read_at ? this.isoOrUndefined(statsRow.latest_read_at) : undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        readThroughEnabled,
        deleteAfterExport,
        archiveFileCount: 0,
        cachedArchiveFileCount: 0,
        cachedEventCount: 0,
        message
      };
    }
  }

  async warmArchiveCacheForPeriod(userId: string, period: string, force: boolean): Promise<{
    ok: boolean;
    message: string;
    filesScanned: number;
    filesRead: number;
    eventsCached: number;
    skippedFiles: number;
    errors: string[];
  }> {
    const readThroughEnabled = this.boolEnv("LISTENING_ARCHIVE_READ_THROUGH_ENABLED", false);
    if (!readThroughEnabled) {
      return { ok: true, message: "Read-through disabled", filesScanned: 0, filesRead: 0, eventsCached: 0, skippedFiles: 0, errors: [] };
    }

    const now = new Date();
    let from: Date;
    switch (period) {
      case "FOUR_WEEKS": from = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000); break;
      case "SIX_MONTHS": from = new Date(now.getTime() - 182 * 24 * 60 * 60 * 1000); break;
      case "TWELVE_MONTHS": from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); break;
      case "ALL_TIME": from = new Date("2000-01-01"); break;
      default: from = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000); break;
    }

    return this.warmArchiveCacheForRange({
      userId,
      from,
      to: now,
      force
    });
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

  private boolEnv(name: string, fallback: boolean): boolean {
    const val = this.config.get<string>(name);
    if (val === undefined || val === null) return fallback;
    return val.toLowerCase() !== "false";
  }

  private numberEnv(name: string, fallback: number): number {
    const val = this.config.get<string>(name);
    if (!val) return fallback;
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  private isoOrUndefined(value: Date | string | null | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}
