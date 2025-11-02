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

  @Field({ nullable: true })
  thumbnailUrl?: string;

  @Field({ nullable: true })
  localThumbnailUrl?: string;

  @Field({ nullable: true })
  driveThumbnailUrl?: string;

  @Field({ nullable: true })
  embeddedArtworkUrl?: string;

  @Field({ nullable: true })
  lyrics?: string;

  @Field({ nullable: true })
  webViewLink?: string;

  @Field({ nullable: true })
  mimeType?: string;

  @Field({ nullable: true })
  modifiedTime?: string;

  @Field(() => Int, { nullable: true })
  sizeBytes?: number;

  @Field({ nullable: true })
  sourceRootFolderId?: string;
}

@ObjectType()
export class SongPageInfo {
  @Field({ nullable: true })
  endCursor?: string;

  @Field()
  hasNextPage!: boolean;
}

@ObjectType()
export class SongConnection {
  @Field(() => [Song])
  nodes!: Song[];

  @Field(() => SongPageInfo)
  pageInfo!: SongPageInfo;

  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class DriveSyncResult {
  @Field()
  ok!: boolean;

  @Field()
  message!: string;

  @Field(() => Int)
  scannedCount!: number;

  @Field(() => Int)
  upsertedCount!: number;

  @Field(() => Int)
  thumbnailCount!: number;
}

@ObjectType()
export class DriveSyncStatus {
  @Field()
  status!: string;

  @Field({ nullable: true })
  startedAt?: string;

  @Field({ nullable: true })
  finishedAt?: string;

  @Field(() => Int)
  scannedCount!: number;

  @Field(() => Int)
  upsertedCount!: number;

  @Field(() => Int)
  thumbnailCount!: number;

  @Field({ nullable: true })
  errorMessage?: string;
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
