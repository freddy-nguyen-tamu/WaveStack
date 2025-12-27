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

@ObjectType()
export class DriveExportResult {
  @Field()
  ok!: boolean;

  @Field()
  message!: string;

  @Field({ nullable: true })
  folderId?: string;

  @Field({ nullable: true })
  credentialsPath?: string;

  @Field({ nullable: true })
  fileId?: string;

  @Field({ nullable: true })
  webViewLink?: string;
}

export type HabitPeriod = "DAY" | "WEEK" | "MONTH" | "YEAR";

@ObjectType()
export class ListeningStatsEntry {
  @Field()
  songId!: string;

  @Field()
  title!: string;

  @Field()
  artistName!: string;

  @Field({ nullable: true })
  albumTitle?: string;

  @Field(() => Int)
  playCount!: number;

  @Field(() => Int, { nullable: true })
  previousPosition?: number;

  @Field(() => Int, { nullable: true })
  position?: number;
}

@ObjectType()
export class RecentlyPlayedEntry {
  @Field()
  songId!: string;

  @Field()
  title!: string;

  @Field()
  artistName!: string;

  @Field({ nullable: true })
  albumTitle?: string;

  @Field()
  playedAt!: string;

  @Field(() => Float)
  completedPlayRatio!: number;
}

@ObjectType()
export class ListeningStatsSnapshot {
  @Field()
  id!: string;

  @Field()
  label!: string;

  @Field()
  createdAt!: string;

  @Field(() => [ListeningStatsEntry])
  entries!: ListeningStatsEntry[];
}

@ObjectType()
export class PlacementPoint {
  @Field()
  snapshotId!: string;

  @Field()
  label!: string;

  @Field()
  createdAt!: string;

  @Field(() => Int, { nullable: true })
  position?: number;
}
