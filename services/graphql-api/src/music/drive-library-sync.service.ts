import { Injectable, Logger } from "@nestjs/common";
import { DriveSyncResult, Song, TitleArtistRepairResult } from "./music.models";
import { GoogleDriveService } from "./google-drive.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { ThumbnailCacheService } from "./thumbnail-cache.service";
import { DriveTitleArtistService } from "./drive-title-artist.service";
import { runSyncWorkers } from "./sync-workers";

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
    let deletedCount = 0;
    let repairedCount = 0;
    let failedCount = 0;

    try {
      const snapshot = await this.googleDriveService.listSongSnapshot();
      const songs = snapshot.songs;
      scannedCount = songs.length;

      upsertedCount = await this.driveTrackRepository.upsertTracks(songs);

      const allIds = songs.map((song) => song.id);
      deletedCount = await this.driveTrackRepository.softDeleteMissingDriveTracks({
        sourceRootFolderIds: snapshot.successfulRootFolderIds,
        currentSongIds: allIds
      });

      // Only generate thumbnails for songs that don't already have one
      // cached. Skips the O(total library) loop for unchanged songs.
      const idsMissingThumbnail = await this.driveTrackRepository.filterIdsMissingLocalThumbnail(allIds);
      const songsNeedingThumbnail = songs.filter((song) => idsMissingThumbnail.has(song.id));

      // Read new, changed or not-yet-indexed files once. Unchanged metadata stays cached in the DB.
      const idsNeedingRepair = await this.driveTrackRepository.filterIdsNeedingTitleArtistRepair(allIds);
      const songsNeedingRepair = songs.filter((song) => idsNeedingRepair.has(song.id));

      const uploadsNeedingSearch = await this.driveTrackRepository.listUploadedTracksNeedingSearch();
      const sweepResult = await this.sweepSongs([...songsNeedingRepair, ...uploadsNeedingSearch]);
      repairedCount = sweepResult.repairedCount;
      failedCount = sweepResult.failedCount;

      // Titles and artists take priority over optional thumbnail generation.
      await runSyncWorkers(songsNeedingThumbnail, 3, async song => {
        try {
          const localThumbnailUrl = await this.thumbnailCacheService.generateForSong(song);
          if (localThumbnailUrl) {
            await this.driveTrackRepository.updateLocalThumbnail(song.id, localThumbnailUrl);
            thumbnailCount += 1;
          }
        } catch (error) {
          this.logger.warn(`Thumbnail sync failed for ${song.id}: ${String(error)}`);
        }
      });

      await this.driveTrackRepository.finishSyncRun(runId, {
        status: "success",
        scannedCount,
        upsertedCount,
        thumbnailCount,
        deletedCount
      });

      const parts: string[] = [];
      parts.push(`Synced ${upsertedCount} track(s) and generated ${thumbnailCount} thumbnail(s).`);
      if (deletedCount > 0) {
        parts.push(`Removed ${deletedCount} deleted Drive track(s) from the active library.`);
      }
      if (repairedCount > 0) {
        parts.push(`Fixed title/artist from ID3 tags for ${repairedCount} track(s).`);
      }
      if (failedCount > 0) {
        parts.push(`${failedCount} track(s) had no title/artist tags or could not be read; failed reads can be retried.`);
      }
      if (snapshot.failedRootFolderIds.length > 0) {
        parts.push(`Skipped stale cleanup for ${snapshot.failedRootFolderIds.length} Drive root(s) that failed to scan.`);
      }

      return {
        ok: true,
        message: parts.join(" "),
        scannedCount,
        upsertedCount,
        thumbnailCount,
        deletedCount
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Drive sync failed: ${message}`);

      await this.driveTrackRepository.finishSyncRun(runId, {
        status: "failed",
        scannedCount,
        upsertedCount,
        thumbnailCount,
        deletedCount,
        errorMessage: message
      });

      return {
        ok: false,
        message,
        scannedCount,
        upsertedCount,
        thumbnailCount,
        deletedCount
      };
    }
  }

  private async sweepSongs(songs: Song[]): Promise<TitleArtistRepairResult> {
    let repairedCount = 0;
    let failedCount = 0;

    await runSyncWorkers(songs, 4, async song => {
      const rawFileId = song.id.replace(/^drive-/, "");

      try {
        const tags = await this.driveTitleArtistService.getEmbeddedTitleArtist(rawFileId, song.modifiedTime, song.streamUrl);
        if (tags) await this.driveTrackRepository.updateEmbeddedSearch(song.id, tags.searchText);

        if (!tags) { failedCount += 1; return; }
        if (!tags.title && !tags.artist) {
          await this.driveTrackRepository.markTitleArtistChecked(song.id);
          failedCount += 1;
          return;
        }

        const nextTitle = song.id.startsWith("drive-") ? tags.title ?? song.title : song.title;
        const nextArtist = song.id.startsWith("drive-") ? tags.artist ?? song.artistName : song.artistName;

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
    });

    return {
      ok: true,
      message: `Swept ${songs.length} track(s), repaired ${repairedCount}, failed ${failedCount}.`,
      attemptedCount: songs.length,
      repairedCount,
      failedCount
    };
  }
}
