import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MusicModule } from "../music/music.module";
import { SearchResolver } from "./search.resolver";

@Module({
  imports: [AuthModule, MusicModule],
  providers: [SearchResolver]
})
export class SearchModule {}
