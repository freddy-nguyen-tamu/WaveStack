import { Query, Resolver } from "@nestjs/graphql";
import { Song } from "../music/music.models";

@Resolver(() => Song)
export class HistoryResolver {
  @Query(() => [Song])
  recentlyPlayed(): Song[] {
    return [
      {
        id: "song-1",
        title: "Cloudline",
        artistName: "The Latency",
        albumTitle: "Regions",
        durationSeconds: 213,
        streamUrl: "/stream/demo",
        genreNames: ["electronic", "ambient"]
      }
    ];
  }
}
