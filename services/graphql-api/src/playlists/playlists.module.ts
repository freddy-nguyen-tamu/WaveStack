import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { MusicModule } from "../music/music.module";
import { PlaylistsResolver } from "./playlists.resolver";
import { PlaylistsService } from "./playlists.service";

@Module({
  imports: [DatabaseModule, MusicModule],
  providers: [PlaylistsResolver, PlaylistsService],
  exports: [PlaylistsService]
})
export class PlaylistsModule {}
