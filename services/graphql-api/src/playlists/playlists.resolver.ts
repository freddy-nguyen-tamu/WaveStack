import { Field, ID, Int, ObjectType, Query, Resolver } from "@nestjs/graphql";

@ObjectType()
class Playlist {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  songCount!: number;
}

@Resolver(() => Playlist)
export class PlaylistsResolver {
  @Query(() => [Playlist])
  playlists(): Playlist[] {
    return [
      { id: "playlist-1", name: "Morning Deploys", songCount: 18 },
      { id: "playlist-2", name: "Late Night Builds", songCount: 24 }
    ];
  }
}
