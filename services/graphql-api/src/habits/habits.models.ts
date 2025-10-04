import { Field, Float, Int, ObjectType } from "@nestjs/graphql";
import { Song } from "../music/music.models";

@ObjectType()
export class RecommendSongResult {
  @Field(() => Song)
  song!: Song;

  @Field()
  reason!: string;
}

@ObjectType()
export class HabitSummaryEntry {
  @Field()
  label!: string;

  @Field(() => Int)
  count!: number;

  @Field(() => Float)
  totalDurationSeconds!: number;
}

export type HabitPeriod = "DAY" | "WEEK" | "MONTH" | "YEAR";
