import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StorageModule } from "../storage/storage.module";
import { MusicResolver } from "./music.resolver";
import { MusicService } from "./music.service";
import { AudioJobsProducer } from "./audio-jobs.producer";

@Module({
  imports: [ConfigModule, StorageModule],
  providers: [MusicResolver, MusicService, AudioJobsProducer],
  exports: [MusicService]
})
export class MusicModule {}
