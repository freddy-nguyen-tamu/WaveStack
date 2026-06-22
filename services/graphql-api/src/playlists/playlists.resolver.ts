import { UnauthorizedException } from "@nestjs/common";
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
  libraryState(@Context() context: GqlContext): Promise<LibraryState> {
    return this.playlistsService.getLibraryState(this.requireUserId(context));
  }

  @Query(() => [UserPlaylist])
  playlists(@Context() context: GqlContext): Promise<UserPlaylist[]> {
    const userId = this.resolveOptionalUserId(context);
    return userId ? this.playlistsService.getPlaylists(userId) : Promise.resolve([]);
  }

  @Query(() => [Song])
  favoriteSongs(@Context() context: GqlContext): Promise<Song[]> {
    return this.playlistsService.getFavoriteSongs(this.requireUserId(context));
  }

  @Query(() => [UserPlaylist])
  userPlaylists(@Context() context: GqlContext): Promise<UserPlaylist[]> {
    return this.playlistsService.getPlaylists(this.requireUserId(context));
  }

  @Mutation(() => [Song])
  favoriteSong(
    @Context() context: GqlContext,
    @Args("songId") songId: string
  ): Promise<Song[]> {
    return this.playlistsService.favoriteSong(this.requireUserId(context), songId);
  }

  @Mutation(() => [Song])
  unfavoriteSong(
    @Context() context: GqlContext,
    @Args("songId") songId: string
  ): Promise<Song[]> {
    return this.playlistsService.unfavoriteSong(this.requireUserId(context), songId);
  }

  @Mutation(() => [Song])
  toggleFavoriteSong(
    @Context() context: GqlContext,
    @Args("songId") songId: string
  ): Promise<Song[]> {
    return this.playlistsService.toggleFavorite(this.requireUserId(context), songId);
  }

  @Mutation(() => [UserPlaylist])
  createUserPlaylist(
    @Context() context: GqlContext,
    @Args("name") name: string
  ): Promise<UserPlaylist[]> {
    return this.playlistsService.createPlaylist(this.requireUserId(context), name);
  }

  @Mutation(() => [UserPlaylist])
  deleteUserPlaylist(
    @Context() context: GqlContext,
    @Args("playlistId") playlistId: string
  ): Promise<UserPlaylist[]> {
    return this.playlistsService.deletePlaylist(this.requireUserId(context), playlistId);
  }

  @Mutation(() => [UserPlaylist])
  addSongToUserPlaylist(
    @Context() context: GqlContext,
    @Args("playlistId") playlistId: string,
    @Args("songId") songId: string
  ): Promise<UserPlaylist[]> {
    return this.playlistsService.addSongToPlaylist(this.requireUserId(context), playlistId, songId);
  }

  @Mutation(() => [UserPlaylist])
  removeSongFromUserPlaylist(
    @Context() context: GqlContext,
    @Args("playlistId") playlistId: string,
    @Args("songId") songId: string
  ): Promise<UserPlaylist[]> {
    return this.playlistsService.removeSongFromPlaylist(this.requireUserId(context), playlistId, songId);
  }

  private requireUserId(context: GqlContext): string {
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
      throw new UnauthorizedException("Sign in again to load or change your WaveStack library.");
    }

    try {
      const token = authHeader.slice(7);
      const payload = this.authService.verifyToken(token);
      return payload.userId;
    } catch {
      throw new UnauthorizedException("Your WaveStack session expired. Sign in again.");
    }
  }

  private resolveOptionalUserId(context: GqlContext): string | null {
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
