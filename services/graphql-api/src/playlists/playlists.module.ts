import { Module } from "@nestjs/common";
import { PlaylistsResolver } from "./playlists.resolver";

@Module({
  providers: [PlaylistsResolver]
})
export class PlaylistsModule {}
