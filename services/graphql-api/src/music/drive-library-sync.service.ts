import { Injectable, Logger } from "@nestjs/common";
import { DriveSyncResult, Song, TitleArtistRepairResult } from "./music.models";
import { GoogleDriveService } from "./google-drive.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { ThumbnailCacheService } from "./thumbnail-cache.service";
import { DriveTitleArtistService } from "./drive-title-artist.service";

@Injectable()
export class DriveLibrarySyncService {
  private readonly logger = new Logger(DriveLibrarySyncService.name);
  private inFlight: Promise<DriveSyncResult> | null = null;

  constructor(
    private readonly googleDriveService: GoogleDriveService,
    private readonly driveTrackRepository: DriveTrackRepository,
    private readonly thumbnailCacheService: ThumbnailCacheService,
    private readonly driveTitleArtistService: DriveTitleArtistService
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
    let repairedCount = 0;
    let failedCount = 0;

    try {
      const songs = await this.googleDriveService.listSongs();
      scannedCount = songs.length;

      upsertedCount = await this.driveTrackRepository.upsertTracks(songs);

      const allIds = songs.map((song) => song.id);

      // Only generate thumbnails for songs that don't already have one
      // cached. Skips the O(total library) loop for unchanged songs.
      const idsMissingThumbnail = await this.driveTrackRepository.filterIdsMissingLocalThumbnail(allIds);
      const songsNeedingThumbnail = songs.filter((song) => idsMissingThumbnail.has(song.id));

      for (const song of songsNeedingThumbnail) {
        const localThumbnailUrl = await this.thumbnailCacheService.generateForSong(song);

        if (localThumbnailUrl) {
          await this.driveTrackRepository.updateLocalThumbnail(song.id, localThumbnailUrl);
          thumbnailCount += 1;
        }
      }

      // Fix title/artist from embedded ID3 tags, but ONLY for songs that
      // have never been successfully checked (title_locked = false).
      // This is what previously re-downloaded the full audio file for
      // every song in the library on every sync -- now it only does that
      // for genuinely new or previously-failed songs.
      // This runs BEFORE finishSyncRun so any error is caught and reported.
      const idsNeedingRepair = await this.driveTrackRepository.filterIdsNeedingTitleArtistRepair(allIds);
      const songsNeedingRepair = songs.filter((song) => idsNeedingRepair.has(song.id));

      const sweepResult = await this.sweepSongs(songsNeedingRepair);
      repairedCount = sweepResult.repairedCount;
      failedCount = sweepResult.failedCount;

      await this.driveTrackRepository.finishSyncRun(runId, {
        status: "success",
        scannedCount,
        upsertedCount,
        thumbnailCount
      });

      const parts: string[] = [];
      parts.push(`Synced ${upsertedCount} track(s) and generated ${thumbnailCount} thumbnail(s).`);
      if (repairedCount > 0) {
        parts.push(`Fixed title/artist from ID3 tags for ${repairedCount} track(s).`);
      }
      if (failedCount > 0) {
        parts.push(`${failedCount} track(s) had no embedded tags.`);
      }

      return {
        ok: true,
        message: parts.join(" "),
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

  private async sweepSongs(songs: Song[]): Promise<TitleArtistRepairResult> {
    let repairedCount = 0;
    let failedCount = 0;

    for (const song of songs) {
      const rawFileId = song.id.replace(/^drive-/, "");

      try {
        const tags = await this.driveTitleArtistService.getEmbeddedTitleArtist(rawFileId);

        if (!tags || (!tags.title && !tags.artist)) {
          await this.driveTrackRepository.markTitleArtistChecked(song.id);
          failedCount += 1;
          continue;
        }

        const nextTitle = tags.title ?? song.title;
        const nextArtist = tags.artist ?? song.artistName;

        await this.driveTrackRepository.updateTitleArtist(song.id, nextTitle, nextArtist);
        repairedCount += 1;
      } catch (error) {
        failedCount += 1;
        this.logger.warn(
          `Title/artist sweep failed for ${song.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return {
      ok: true,
      message: `Swept ${songs.length} track(s), repaired ${repairedCount}, failed ${failedCount}.`,
      attemptedCount: songs.length,
      repairedCount,
      failedCount
    };
  }
}
