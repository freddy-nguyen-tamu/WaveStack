import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MusicModule } from "../music/music.module";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { HabitsService } from "./habits.service";
import { HabitsResolver } from "./habits.resolver";
import { DrivePrivateExportService } from "./drive-private-export.service";
import { GroqTasteService } from "./groq-taste.service";

@Module({
  imports: [ConfigModule, DatabaseModule, MusicModule, AuthModule],
  providers: [HabitsService, HabitsResolver, DrivePrivateExportService, GroqTasteService]
})
export class HabitsModule {}
