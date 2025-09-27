import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StorageModule } from "../storage/storage.module";
import { MusicResolver } from "./music.resolver";
import { MusicService } from "./music.service";
import { AudioJobsProducer } from "./audio-jobs.producer";
import { GoogleDriveService } from "./google-drive.service";
import { GoogleDriveController } from "./google-drive.controller";
import { DriveArtworkService } from "./drive-artwork.service";

@Module({
  imports: [ConfigModule, StorageModule],
  controllers: [GoogleDriveController],
  providers: [
    MusicResolver,
    MusicService,
    AudioJobsProducer,
    GoogleDriveService,
    DriveArtworkService
  ],
  exports: [MusicService]
})
export class MusicModule {}
