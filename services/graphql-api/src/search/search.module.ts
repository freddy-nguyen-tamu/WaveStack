import { Module } from "@nestjs/common";
import { MusicModule } from "../music/music.module";
import { SearchResolver } from "./search.resolver";

@Module({
  imports: [MusicModule],
  providers: [SearchResolver]
})
export class SearchModule {}
