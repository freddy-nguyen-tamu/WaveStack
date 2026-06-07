import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MusicModule } from "../music/music.module";
import { RecommendationsResolver } from "./recommendations.resolver";

@Module({
  imports: [AuthModule, MusicModule],
  providers: [RecommendationsResolver]
})
export class RecommendationsModule {}
