import { Query, Resolver } from "@nestjs/graphql";
import { Song } from "../music/music.models";

@Resolver(() => Song)
export class RecommendationsResolver {
  @Query(() => [Song])
  recommendations(): Song[] {
    return [
      {
        id: "song-2",
        title: "Packet Chorus",
        artistName: "Blue Queue",
        albumTitle: "Async Hearts",
        durationSeconds: 188,
        streamUrl: "/stream/recommended",
        genreNames: ["indie", "pop"],
        score: 0.91
      }
    ];
  }
}
