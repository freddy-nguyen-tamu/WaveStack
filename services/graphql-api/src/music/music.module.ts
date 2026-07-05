import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StorageModule } from "../storage/storage.module";
import { DatabaseModule } from "../database/database.module";
import { AuthModule } from "../auth/auth.module";
import { MusicResolver } from "./music.resolver";
import { MusicService } from "./music.service";
import { AudioJobsProducer } from "./audio-jobs.producer";
import { GoogleDriveService } from "./google-drive.service";
import { GoogleDriveController } from "./google-drive.controller";
import { DriveArtworkService } from "./drive-artwork.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { DriveLibrarySyncService } from "./drive-library-sync.service";
import { ThumbnailCacheService } from "./thumbnail-cache.service";
import { ThumbnailRepairService } from "./thumbnail-repair.service";
import { DriveDownloadService } from "./drive-download.service";
import { DriveLyricsService } from "./drive-lyrics.service";
import { LyricsRepairService } from "./lyrics-repair.service";
import { DriveTitleArtistService } from "./drive-title-artist.service";
import { TitleArtistRepairService } from "./title-artist-repair.service";
import { UploadsController } from "./uploads.controller";

@Module({
  imports: [ConfigModule, StorageModule, DatabaseModule, AuthModule],
  controllers: [GoogleDriveController, UploadsController],
  providers: [
    MusicResolver,
    MusicService,
    AudioJobsProducer,
    GoogleDriveService,
    DriveArtworkService,
    DriveTrackRepository,
    DriveLibrarySyncService,
    ThumbnailCacheService,
    ThumbnailRepairService,
    DriveDownloadService,
    DriveLyricsService,
    LyricsRepairService,
    DriveTitleArtistService,
    TitleArtistRepairService
  ],
  exports: [MusicService, DriveTrackRepository, GoogleDriveService]
})
export class MusicModule {}
