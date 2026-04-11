import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { PlaylistsService } from "./playlists.service";
import { LibraryState, UserPlaylist } from "./playlists.models";
import { Song } from "../music/music.models";

type GqlContext = {
  req?: {
    user?: {
      id?: string;
      userId?: string;
      sub?: string;
    };
  };
};

@Resolver()
export class PlaylistsResolver {
  constructor(private readonly playlistsService: PlaylistsService) {}

  @Query(() => LibraryState)
  async libraryState(@Context() context: GqlContext): Promise<LibraryState> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return { favorites: [], playlists: [], recentlyPlayed: [] };
    }

    return this.playlistsService.getLibraryState(userId);
  }

  @Query(() => [Song])
  async favoriteSongs(@Context() context: GqlContext): Promise<Song[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.getFavoriteSongs(userId) : [];
  }

  @Query(() => [UserPlaylist])
  async userPlaylists(@Context() context: GqlContext): Promise<UserPlaylist[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.getPlaylists(userId) : [];
  }

  @Query(() => [UserPlaylist])
  async playlists(@Context() context: GqlContext): Promise<UserPlaylist[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.getPlaylists(userId) : [];
  }

  @Mutation(() => [Song])
  async favoriteSong(
    @Context() context: GqlContext,
    @Args("songId") songId: string
  ): Promise<Song[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.favoriteSong(userId, songId) : [];
  }

  @Mutation(() => [Song])
  async unfavoriteSong(
    @Context() context: GqlContext,
    @Args("songId") songId: string
  ): Promise<Song[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.unfavoriteSong(userId, songId) : [];
  }

  @Mutation(() => [Song])
  async toggleFavoriteSong(
    @Context() context: GqlContext,
    @Args("songId") songId: string
  ): Promise<Song[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.toggleFavorite(userId, songId) : [];
  }

  @Mutation(() => [UserPlaylist])
  async createUserPlaylist(
    @Context() context: GqlContext,
    @Args("name") name: string
  ): Promise<UserPlaylist[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.createPlaylist(userId, name) : [];
  }

  @Mutation(() => [UserPlaylist])
  async deleteUserPlaylist(
    @Context() context: GqlContext,
    @Args("playlistId") playlistId: string
  ): Promise<UserPlaylist[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.deletePlaylist(userId, playlistId) : [];
  }

  @Mutation(() => [UserPlaylist])
  async addSongToUserPlaylist(
    @Context() context: GqlContext,
    @Args("playlistId") playlistId: string,
    @Args("songId") songId: string
  ): Promise<UserPlaylist[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.addSongToPlaylist(userId, playlistId, songId) : [];
  }

  @Mutation(() => [UserPlaylist])
  async removeSongFromUserPlaylist(
    @Context() context: GqlContext,
    @Args("playlistId") playlistId: string,
    @Args("songId") songId: string
  ): Promise<UserPlaylist[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.removeSongFromPlaylist(userId, playlistId, songId) : [];
  }

  private resolveUserId(context: GqlContext): string | null {
    return (
      context.req?.user?.userId ??
      context.req?.user?.id ??
      context.req?.user?.sub ??
      null
    );
  }
}
