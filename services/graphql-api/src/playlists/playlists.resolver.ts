import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { AuthService } from "../auth/auth.service";
import { Song } from "../music/music.models";
import { LibraryState, UserPlaylist } from "./playlists.models";
import { PlaylistsService } from "./playlists.service";

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

@Resolver()
export class PlaylistsResolver {
  constructor(
    private readonly playlistsService: PlaylistsService,
    private readonly authService: AuthService
  ) {}

  @Query(() => LibraryState)
  async libraryState(@Context() context: GqlContext): Promise<LibraryState> {
    const userId = this.resolveUserId(context);
    return userId
      ? this.playlistsService.getLibraryState(userId)
      : { favorites: [], playlists: [], recentlyPlayed: [] };
  }

  @Query(() => [UserPlaylist])
  async playlists(@Context() context: GqlContext): Promise<UserPlaylist[]> {
    const userId = this.resolveUserId(context);
    return userId ? this.playlistsService.getPlaylists(userId) : [];
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
    return userId
      ? this.playlistsService.addSongToPlaylist(userId, playlistId, songId)
      : [];
  }

  @Mutation(() => [UserPlaylist])
  async removeSongFromUserPlaylist(
    @Context() context: GqlContext,
    @Args("playlistId") playlistId: string,
    @Args("songId") songId: string
  ): Promise<UserPlaylist[]> {
    const userId = this.resolveUserId(context);
    return userId
      ? this.playlistsService.removeSongFromPlaylist(userId, playlistId, songId)
      : [];
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
      const token = authHeader.slice(7);
      const payload = this.authService.verifyToken(token);
      return payload.userId;
    } catch {
      return null;
    }
  }
}
