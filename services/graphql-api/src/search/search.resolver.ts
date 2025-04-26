import { Args, Query, Resolver } from "@nestjs/graphql";
import { Song } from "../music/music.models";
import { MusicService } from "../music/music.service";

@Resolver(() => Song)
export class SearchResolver {
  constructor(private readonly musicService: MusicService) {}

  @Query(() => [Song])
  async search(@Args("query") query: string): Promise<Song[]> {
    const needle = query.toLowerCase();
    const songs = await this.musicService.listSongs();

    return songs.filter((song) =>
      [song.title, song.artistName, song.albumTitle, ...song.genreNames]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }
}
