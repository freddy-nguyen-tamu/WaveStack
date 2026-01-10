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
  key!: string;

  @Field()
  label!: string;

  @Field()
  subtitle!: string;

  @Field(() => Int)
  rank!: number;

  @Field(() => Int)
  previousRank!: number;

  @Field(() => Int)
  rankChange!: number;

  @Field(() => Int)
  playCount!: number;

  @Field(() => Float)
  totalDurationSeconds!: number;

  @Field({ nullable: true })
  songId?: string;

  @Field({ nullable: true })
  thumbnailUrl?: string;
}

@ObjectType()
export class RecentlyPlayedEntry {
  @Field()
  songId!: string;

  @Field()
  title!: string;

  @Field()
  artistName!: string;

  @Field(() => Int)
  durationSeconds!: number;

  @Field(() => Float)
  completedPlayRatio!: number;

  @Field()
  startedAt!: string;
}

@ObjectType()
export class ListeningStatsSnapshot {
  @Field()
  id!: string;

  @Field()
  statType!: string;

  @Field()
  period!: string;

  @Field()
  label!: string;

  @Field()
  generatedAt!: string;

  @Field(() => [ListeningStatsEntry])
  entries!: ListeningStatsEntry[];
}

@ObjectType()
export class PlacementPoint {
  @Field()
  snapshotId!: string;

  @Field()
  generatedAt!: string;

  @Field(() => Int)
  rank!: number;
}

@ObjectType()
export class TasteJudgeResult {
  @Field()
  ok!: boolean;

  @Field()
  verdictTitle!: string;

  @Field()
  roast!: string;

  @Field()
  summary!: string;

  @Field(() => [String])
  badges!: string[];

  @Field(() => Int)
  tasteScore!: number;

  @Field(() => Int)
  obscurityScore!: number;

  @Field(() => Int)
  chaosScore!: number;

  @Field()
  generatedAt!: string;
}

@ObjectType()
export class TasteComparisonResult {
  @Field(() => Int)
  userPlayCount!: number;

  @Field(() => Int)
  libraryUserCount!: number;

  @Field(() => Int)
  obscurityScore!: number;

  @Field(() => Int)
  mainstreamScore!: number;

  @Field(() => Int)
  uniquenessScore!: number;

  @Field(() => Int)
  overlapScore!: number;

  @Field(() => [ListeningStatsEntry])
  rareArtists!: ListeningStatsEntry[];

  @Field(() => [ListeningStatsEntry])
  commonArtists!: ListeningStatsEntry[];
}
