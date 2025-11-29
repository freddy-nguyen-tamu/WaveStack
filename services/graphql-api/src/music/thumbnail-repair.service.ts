import { Injectable, Logger } from "@nestjs/common";
import { DriveArtworkService } from "./drive-artwork.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { ThumbnailCacheService } from "./thumbnail-cache.service";
import { ThumbnailRepairResult } from "./music.models";

@Injectable()
export class ThumbnailRepairService {
  private readonly logger = new Logger(ThumbnailRepairService.name);
  private inFlight: Promise<ThumbnailRepairResult> | null = null;

  constructor(
    private readonly driveArtworkService: DriveArtworkService,
    private readonly driveTrackRepository: DriveTrackRepository,
    private readonly thumbnailCacheService: ThumbnailCacheService
  ) {}

  repairMissingEmbeddedArtwork(limit: number): Promise<ThumbnailRepairResult> {
    if (this.inFlight) {
      return Promise.resolve({
        ok: false,
        message: "A thumbnail repair batch is already running.",
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

  private async runBatch(limit: number): Promise<ThumbnailRepairResult> {
    const songs = await this.driveTrackRepository.listTracksMissingLocalThumbnails(limit);

    let repairedCount = 0;
    let failedCount = 0;

    for (const song of songs) {
      const rawFileId = song.id.replace(/^drive-/, "");

      try {
        const embedded = await this.withTimeout(
          this.driveArtworkService.getEmbeddedArtwork(rawFileId),
          15000
        );

        if (!embedded?.buffer?.length) {
          failedCount += 1;
          continue;
        }

        const localThumbnailUrl = await this.thumbnailCacheService.writeEmbeddedArtwork(
          song.id,
          embedded.buffer
        );

        if (!localThumbnailUrl) {
          failedCount += 1;
          continue;
        }

        await this.driveTrackRepository.updateLocalThumbnail(song.id, localThumbnailUrl);
        repairedCount += 1;
      } catch (error) {
        failedCount += 1;
        this.logger.warn(
          `Embedded thumbnail repair failed for ${song.id}: ${
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
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
