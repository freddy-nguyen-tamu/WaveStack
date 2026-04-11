import { Field, Int, ObjectType } from "@nestjs/graphql";
import { Song } from "../music/music.models";

@ObjectType()
export class UserPlaylist {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  songCount!: number;

  @Field(() => [String])
  songIds!: string[];

  @Field(() => [Song])
  songs!: Song[];

  @Field()
  createdAt!: string;

  @Field()
  updatedAt!: string;
}

@ObjectType()
export class LibraryState {
  @Field(() => [Song])
  favorites!: Song[];

  @Field(() => [UserPlaylist])
  playlists!: UserPlaylist[];

  @Field(() => [Song])
  recentlyPlayed!: Song[];
}
