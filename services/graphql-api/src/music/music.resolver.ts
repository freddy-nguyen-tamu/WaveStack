import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { AuthService } from "../auth/auth.service";
import {
  Album,
  Artist,
  DriveSyncResult,
  DriveSyncStatus,
  LyricsRepairResult,
  Song,
  SongConnection,
  ThumbnailRepairResult,
  TitleArtistRepairResult,
  UserSongAttributeInput,
  UserSongInput
} from "./music.models";
import { MusicService } from "./music.service";
import { DriveLibrarySyncService } from "./drive-library-sync.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { ThumbnailRepairService } from "./thumbnail-repair.service";
import { LyricsRepairService } from "./lyrics-repair.service";
import { TitleArtistRepairService } from "./title-artist-repair.service";

type GqlContext = {
  req?: {
    headers?: {
      authorization?: string;
    };
    user?: {
      id?: string;
      userId?: string;
      sub?: string;
    };
  };
};

@Resolver(() => Song)
export class MusicResolver {
  constructor(
    private readonly musicService: MusicService,
    private readonly driveLibrarySyncService: DriveLibrarySyncService,
    private readonly driveTrackRepository: DriveTrackRepository,
    private readonly thumbnailRepairService: ThumbnailRepairService,
    private readonly lyricsRepairService: LyricsRepairService,
    private readonly titleArtistRepairService: TitleArtistRepairService,
    private readonly authService: AuthService
  ) {}

  @Query(() => [Song])
  songs(): Promise<Song[]> {
    return this.musicService.listSongs();
  }

  @Query(() => SongConnection)
  songPage(
    @Context() context: GqlContext,
    @Args("first", { type: () => Int, nullable: true }) first?: number,
    @Args("after", { nullable: true }) after?: string,
    @Args("query", { nullable: true }) query?: string,
    @Args("sort", { nullable: true }) sort?: string
  ): Promise<SongConnection> {
    return this.musicService.songPage(first ?? 50, after, query, this.resolveUserId(context), sort);
  }

  @Query(() => [Song])
  dashboardSongs(
    @Context() context: GqlContext,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<Song[]> {
    return this.musicService.dashboardSongs(limit ?? 40, this.resolveUserId(context));
  }

  @Query(() => Song, { nullable: true })
  songDetails(@Context() context: GqlContext, @Args("id") id: string): Promise<Song | null> {
    return this.musicService.songDetails(id, this.resolveUserId(context));
  }

  @Mutation(() => Song)
  async createUserSong(
    @Context() context: GqlContext,
    @Args("input") input: UserSongInput
  ): Promise<Song> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return this.emptyPrivateSong();
    }

    const songs = await this.musicService.createUserSongs(userId, [input]);
    return songs[0] ?? this.emptyPrivateSong();
  }

  @Mutation(() => [Song])
  async createUserSongs(
    @Context() context: GqlContext,
    @Args("inputs", { type: () => [UserSongInput] }) inputs: UserSongInput[]
  ): Promise<Song[]> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return [];
    }

    return this.musicService.createUserSongs(userId, inputs);
  }

  @Mutation(() => Song, { nullable: true })
  updateUserSongAttributes(
    @Context() context: GqlContext,
    @Args("songId") songId: string,
    @Args("input") input: UserSongAttributeInput
  ): Promise<Song | null> {
    const userId = this.resolveUserId(context);
    return userId ? this.musicService.updateUserSongAttributes(userId, songId, input) : Promise.resolve(null);
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

  @Mutation(() => LyricsRepairResult)
  repairEmbeddedLyricsForSong(
    @Args("songId") songId: string
  ): Promise<LyricsRepairResult> {
    return this.lyricsRepairService.repairEmbeddedLyricsForSong(songId);
  }

  @Mutation(() => TitleArtistRepairResult)
  repairEmbeddedTitleArtist(
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<TitleArtistRepairResult> {
    return this.titleArtistRepairService.repairMissingEmbeddedTitleArtist(limit ?? 10);
  }

  @Mutation(() => TitleArtistRepairResult)
  repairEmbeddedTitleArtistForSong(
    @Args("songId") songId: string
  ): Promise<TitleArtistRepairResult> {
    return this.titleArtistRepairService.repairEmbeddedTitleArtistForSong(songId);
  }

  @Mutation(() => Boolean)
  processUploadedSong(
    @Args("songId") songId: string,
    @Args("blobUrl") blobUrl: string,
    @Args("userId") userId: string
  ): Promise<boolean> {
    return this.musicService.requestUploadProcessing(songId, blobUrl, userId);
  }

  private resolveUserId(context: GqlContext): string | null {
    const contextUserId =
      context.req?.user?.userId ??
      context.req?.user?.id ??
      context.req?.user?.sub ??
      null;

    if (contextUserId) {
      return contextUserId;
    }

    const authHeader = context.req?.headers?.authorization ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      return null;
    }

    try {
      return this.authService.verifyToken(authHeader.slice(7)).userId;
    } catch {
      return null;
    }
  }

  private emptyPrivateSong(): Song {
    return {
      id: "",
      title: "",
      artistName: "",
      albumTitle: "",
      durationSeconds: 0,
      streamUrl: "",
      genreNames: []
    };
  }
}
