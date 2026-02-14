import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MusicModule } from "../music/music.module";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { HabitsService } from "./habits.service";
import { HabitsResolver } from "./habits.resolver";
import { DrivePrivateExportService } from "./drive-private-export.service";
import { GroqTasteService } from "./groq-taste.service";
import { ListeningArchiveService } from "./listening-archive.service";
import { ListeningArchiveController } from "./listening-archive.controller";

@Module({
  imports: [ConfigModule, DatabaseModule, MusicModule, AuthModule],
  controllers: [ListeningArchiveController],
  providers: [HabitsService, HabitsResolver, DrivePrivateExportService, ListeningArchiveService, GroqTasteService]
})
export class HabitsModule {}
