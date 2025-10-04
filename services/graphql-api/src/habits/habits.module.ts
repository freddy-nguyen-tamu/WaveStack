import { Module } from "@nestjs/common";
import { MusicModule } from "../music/music.module";
import { AuthModule } from "../auth/auth.module";
import { HabitsService } from "./habits.service";
import { HabitsResolver } from "./habits.resolver";

@Module({
  imports: [MusicModule, AuthModule],
  providers: [HabitsService, HabitsResolver]
})
export class HabitsModule {}
