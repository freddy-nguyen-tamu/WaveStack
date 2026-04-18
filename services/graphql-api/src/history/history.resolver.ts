import { Query, Resolver } from "@nestjs/graphql";
import { Song } from "../music/music.models";

@Resolver(() => Song)
export class HistoryResolver {
  @Query(() => [Song])
  recentlyPlayed(): Song[] {
    return [];
  }
}
