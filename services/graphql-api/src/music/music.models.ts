import { Field, Float, ID, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class Song {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  artistName!: string;

  @Field()
  albumTitle!: string;

  @Field(() => Int)
  durationSeconds!: number;

  @Field()
  streamUrl!: string;

  @Field(() => [String])
  genreNames!: string[];

  @Field(() => Float, { nullable: true })
  score?: number;
}

@ObjectType()
export class Album {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  artistName!: string;
}

@ObjectType()
export class Artist {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;
}
