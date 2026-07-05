import { Injectable, Logger } from "@nestjs/common";
import { DriveTitleArtistService } from "./drive-title-artist.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { TitleArtistRepairResult } from "./music.models";

@Injectable()
export class TitleArtistRepairService {
  private readonly logger = new Logger(TitleArtistRepairService.name);
  private inFlight: Promise<TitleArtistRepairResult> | null = null;

  constructor(
    private readonly driveTitleArtistService: DriveTitleArtistService,
    private readonly driveTrackRepository: DriveTrackRepository
  ) {}

  async repairEmbeddedTitleArtistForSong(songId: string): Promise<TitleArtistRepairResult> {
    const song = await this.driveTrackRepository.getSong(songId);

    if (!song) {
      return {
        ok: false,
        message: "Song was not found in the Drive track cache.",
        attemptedCount: 0,
        repairedCount: 0,
        failedCount: 1
      };
    }

    const rawFileId = song.id.replace(/^drive-/, "");

    try {
      const tags = await this.withTimeout(
        this.driveTitleArtistService.getEmbeddedTitleArtist(rawFileId),
        20000
      );

      if (!tags || (!tags.title && !tags.artist)) {
        return {
          ok: true,
          message: "No embedded title/artist tags were found for this song.",
          attemptedCount: 1,
          repairedCount: 0,
          failedCount: 1
        };
      }

      const nextTitle = tags.title ?? song.title;
      const nextArtist = tags.artist ?? song.artistName;

      await this.driveTrackRepository.updateTitleArtist(song.id, nextTitle, nextArtist);

      return {
        ok: true,
        message: "Title and artist were updated from the file's embedded tags.",
        attemptedCount: 1,
        repairedCount: 1,
        failedCount: 0
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Title/artist repair failed for ${song.id}: ${message}`);

      return {
        ok: false,
        message: `Could not read embedded tags: ${message}`,
        attemptedCount: 1,
        repairedCount: 0,
        failedCount: 1
      };
    }
  }

  repairMissingEmbeddedTitleArtist(limit: number): Promise<TitleArtistRepairResult> {
    if (this.inFlight) {
      return Promise.resolve({
        ok: false,
        message: "A title/artist repair batch is already running.",
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

  private async runBatch(limit: number): Promise<TitleArtistRepairResult> {
    const songs = await this.driveTrackRepository.listTracksNeedingTitleArtistRepair(limit);

    let repairedCount = 0;
    let failedCount = 0;

    for (const song of songs) {
      const rawFileId = song.id.replace(/^drive-/, "");

      try {
        const tags = await this.withTimeout(
          this.driveTitleArtistService.getEmbeddedTitleArtist(rawFileId),
          20000
        );

        if (!tags || (!tags.title && !tags.artist)) {
          // No usable tags -- lock it anyway so this track isn't
          // redownloaded and re-parsed on every future batch run. Its
          // current filename-derived title/artist stays as-is.
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
          `Title/artist repair failed for ${song.id}: ${
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
