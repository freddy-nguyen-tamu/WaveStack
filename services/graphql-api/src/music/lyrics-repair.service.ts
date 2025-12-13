import { Injectable, Logger } from "@nestjs/common";
import { DriveLyricsService } from "./drive-lyrics.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { LyricsRepairResult } from "./music.models";

@Injectable()
export class LyricsRepairService {
  private readonly logger = new Logger(LyricsRepairService.name);
  private inFlight: Promise<LyricsRepairResult> | null = null;

  constructor(
    private readonly driveLyricsService: DriveLyricsService,
    private readonly driveTrackRepository: DriveTrackRepository
  ) {}

  repairMissingEmbeddedLyrics(limit: number): Promise<LyricsRepairResult> {
    if (this.inFlight) {
      return Promise.resolve({
        ok: false,
        message: "A lyrics repair batch is already running.",
        attemptedCount: 0,
        repairedCount: 0,
        failedCount: 0
      });
    }

    const safeLimit = Math.max(1, Math.min(limit || 10, 25));

    this.inFlight = this.runBatch(safeLimit).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async runBatch(limit: number): Promise<LyricsRepairResult> {
    const songs = await this.driveTrackRepository.listTracksMissingLyrics(limit);

    let repairedCount = 0;
    let failedCount = 0;

    for (const song of songs) {
      const rawFileId = song.id.replace(/^drive-/, "");

      try {
        const lyrics = await this.withTimeout(
          this.driveLyricsService.getEmbeddedLyrics(rawFileId),
          20000
        );

        if (!lyrics?.trim()) {
          failedCount += 1;
          continue;
        }

        await this.driveTrackRepository.updateLyrics(song.id, lyrics);
        repairedCount += 1;
      } catch (error) {
        failedCount += 1;

        this.logger.warn(
          `Embedded lyrics repair failed for ${song.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return {
      ok: true,
      message: `Attempted ${songs.length} track(s), repaired ${repairedCount}, failed ${failedCount}.`,
      attemptedCount: songs.length,
      repairedCount,
      failedCount
    };
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
