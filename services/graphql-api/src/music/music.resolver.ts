import { Args, Mutation, Query, Resolver } from "@nestjs/graphql";
import { Album, Artist, Song } from "./music.models";
import { MusicService } from "./music.service";

@Resolver(() => Song)
export class MusicResolver {
  constructor(private readonly musicService: MusicService) {}

  @Query(() => [Song])
  songs(): Promise<Song[]> {
    return this.musicService.listSongs();
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

  @Mutation(() => Boolean)
  processUploadedSong(
    @Args("songId") songId: string,
    @Args("blobUrl") blobUrl: string,
    @Args("userId") userId: string
  ): Promise<boolean> {
    return this.musicService.requestUploadProcessing(songId, blobUrl, userId);
  }
}
