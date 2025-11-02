import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StorageModule } from "../storage/storage.module";
import { DatabaseModule } from "../database/database.module";
import { MusicResolver } from "./music.resolver";
import { MusicService } from "./music.service";
import { AudioJobsProducer } from "./audio-jobs.producer";
import { GoogleDriveService } from "./google-drive.service";
import { GoogleDriveController } from "./google-drive.controller";
import { DriveArtworkService } from "./drive-artwork.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { DriveLibrarySyncService } from "./drive-library-sync.service";
import { ThumbnailCacheService } from "./thumbnail-cache.service";

@Module({
  imports: [ConfigModule, StorageModule, DatabaseModule],
  controllers: [GoogleDriveController],
  providers: [
    MusicResolver,
    MusicService,
    AudioJobsProducer,
    GoogleDriveService,
    DriveArtworkService,
    DriveTrackRepository,
    DriveLibrarySyncService,
    ThumbnailCacheService
  ],
  exports: [MusicService, DriveTrackRepository]
})
export class MusicModule {}
