import { Injectable, Logger } from "@nestjs/common";
import { DriveSyncResult } from "./music.models";
import { GoogleDriveService } from "./google-drive.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { ThumbnailCacheService } from "./thumbnail-cache.service";

@Injectable()
export class DriveLibrarySyncService {
  private readonly logger = new Logger(DriveLibrarySyncService.name);
  private inFlight: Promise<DriveSyncResult> | null = null;

  constructor(
    private readonly googleDriveService: GoogleDriveService,
    private readonly driveTrackRepository: DriveTrackRepository,
    private readonly thumbnailCacheService: ThumbnailCacheService
  ) {}

  async syncDriveLibrary(): Promise<DriveSyncResult> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.runSync().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async runSync(): Promise<DriveSyncResult> {
    const runId = await this.driveTrackRepository.createSyncRun();
    let scannedCount = 0;
    let upsertedCount = 0;
    let thumbnailCount = 0;

    try {
      const songs = await this.googleDriveService.listSongs();
      scannedCount = songs.length;

      upsertedCount = await this.driveTrackRepository.upsertTracks(songs);

      for (const song of songs) {
        const localThumbnailUrl = await this.thumbnailCacheService.generateForSong(song);

        if (localThumbnailUrl) {
          await this.driveTrackRepository.updateLocalThumbnail(song.id, localThumbnailUrl);
          thumbnailCount += 1;
        }
      }

      await this.driveTrackRepository.finishSyncRun(runId, {
        status: "success",
        scannedCount,
        upsertedCount,
        thumbnailCount
      });

      return {
        ok: true,
        message: `Synced ${upsertedCount} track(s) and generated ${thumbnailCount} thumbnail(s).`,
        scannedCount,
        upsertedCount,
        thumbnailCount
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Drive sync failed: ${message}`);

      await this.driveTrackRepository.finishSyncRun(runId, {
        status: "failed",
        scannedCount,
        upsertedCount,
        thumbnailCount,
        errorMessage: message
      });

      return {
        ok: false,
        message,
        scannedCount,
        upsertedCount,
        thumbnailCount
      };
    }
  }
}
