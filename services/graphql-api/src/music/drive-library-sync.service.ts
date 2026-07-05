import { Injectable, Logger } from "@nestjs/common";
import { DriveSyncResult } from "./music.models";
import { GoogleDriveService } from "./google-drive.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { ThumbnailCacheService } from "./thumbnail-cache.service";
import { TitleArtistRepairService } from "./title-artist-repair.service";

@Injectable()
export class DriveLibrarySyncService {
  private readonly logger = new Logger(DriveLibrarySyncService.name);
  private inFlight: Promise<DriveSyncResult> | null = null;

  constructor(
    private readonly googleDriveService: GoogleDriveService,
    private readonly driveTrackRepository: DriveTrackRepository,
    private readonly thumbnailCacheService: ThumbnailCacheService,
    private readonly titleArtistRepairService: TitleArtistRepairService
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

      // Block until all new tracks have had their title/artist fixed
      // from embedded ID3 tags. This guarantees that after one sync
      // returns, every track's title and artist is correct.
      await this.sweepNewTracks();

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

  private async sweepNewTracks(): Promise<void> {
    this.logger.log("Starting automatic post-sync title/artist sweep for new tracks...");

    try {
      const result = await this.titleArtistRepairService.repairMissingEmbeddedTitleArtist(25);
      this.logger.log(
        `Post-sync sweep: attempted ${result.attemptedCount}, repaired ${result.repairedCount}, failed ${result.failedCount}.`
      );

      // Keep sweeping in batches until every unfixed track has been
      // either repaired or marked as tagless. Each batch picks up
      // tracks where title_locked is still false.
      if (result.attemptedCount > 0) {
        void this.sweepNewTracks();
      }
    } catch (error) {
      this.logger.error(
        `Post-sync title/artist sweep error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
