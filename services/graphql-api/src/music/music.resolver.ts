import { Args, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import {
  Album,
  Artist,
  DriveSyncResult,
  DriveSyncStatus,
  LyricsRepairResult,
  Song,
  SongConnection,
  ThumbnailRepairResult
} from "./music.models";
import { MusicService } from "./music.service";
import { DriveLibrarySyncService } from "./drive-library-sync.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { ThumbnailRepairService } from "./thumbnail-repair.service";
import { LyricsRepairService } from "./lyrics-repair.service";

@Resolver(() => Song)
export class MusicResolver {
  constructor(
    private readonly musicService: MusicService,
    private readonly driveLibrarySyncService: DriveLibrarySyncService,
    private readonly driveTrackRepository: DriveTrackRepository,
    private readonly thumbnailRepairService: ThumbnailRepairService,
    private readonly lyricsRepairService: LyricsRepairService
  ) {}

  @Query(() => [Song])
  songs(): Promise<Song[]> {
    return this.musicService.listSongs();
  }

  @Query(() => SongConnection)
  songPage(
    @Args("first", { type: () => Int, nullable: true }) first?: number,
    @Args("after", { nullable: true }) after?: string,
    @Args("query", { nullable: true }) query?: string
  ): Promise<SongConnection> {
    return this.musicService.songPage(first ?? 50, after, query);
  }

  @Query(() => [Song])
  dashboardSongs(
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<Song[]> {
    return this.musicService.dashboardSongs(limit ?? 40);
  }

  @Query(() => Song, { nullable: true })
  songDetails(@Args("id") id: string): Promise<Song | null> {
    return this.musicService.songDetails(id);
  }

  @Query(() => DriveSyncStatus)
  driveSyncStatus(): Promise<DriveSyncStatus> {
    return this.driveTrackRepository.latestSyncStatus();
  }

  @Mutation(() => DriveSyncResult)
  syncDriveLibrary(): Promise<DriveSyncResult> {
    return this.driveLibrarySyncService.syncDriveLibrary();
  }

  @Query(() => [Album])
  albums(): Promise<Album[]> {
    return this.musicService.listAlbums();
  }

  @Query(() => [Artist])
  artists(): Promise<Artist[]> {
    return this.musicService.listArtists();
  }

  @Query(() => [Song])
  favoriteSongs(): Promise<Song[]> {
    return this.musicService.listFavoriteSongs();
  }

  @Mutation(() => ThumbnailRepairResult)
  repairEmbeddedArtworkThumbnails(
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<ThumbnailRepairResult> {
    return this.thumbnailRepairService.repairMissingEmbeddedArtwork(limit ?? 10);
  }

  @Mutation(() => LyricsRepairResult)
  repairEmbeddedLyrics(
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<LyricsRepairResult> {
    return this.lyricsRepairService.repairMissingEmbeddedLyrics(limit ?? 10);
  }

  @Mutation(() => Boolean)
  processUploadedSong(
    @Args("songId") songId: string,
    @Args("blobUrl") blobUrl: string,
    @Args("userId") userId: string
  ): Promise<boolean> {
    return this.musicService.requestUploadProcessing(songId, blobUrl, userId);
  }
}
