import { Args, Int, Query, Resolver } from "@nestjs/graphql";
import { Song } from "../music/music.models";
import { MusicService } from "../music/music.service";

@Resolver(() => Song)
export class SearchResolver {
  constructor(private readonly musicService: MusicService) {}

  @Query(() => [Song])
  async search(
    @Args("query") query: string,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<Song[]> {
    const page = await this.musicService.songPage(limit ?? 50, null, query);
    return page.nodes;
  }
}
