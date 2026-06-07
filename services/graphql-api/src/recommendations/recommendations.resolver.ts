import { Context, Query, Resolver } from "@nestjs/graphql";
import { AuthService } from "../auth/auth.service";
import { Song } from "../music/music.models";
import { MusicService } from "../music/music.service";

type GqlContext = {
  req?: {
    headers?: {
      authorization?: string;
    };
  };
};

@Resolver(() => Song)
export class RecommendationsResolver {
  constructor(
    private readonly musicService: MusicService,
    private readonly authService: AuthService
  ) {}

  @Query(() => [Song])
  recommendations(@Context() context: GqlContext): Promise<Song[]> {
    return this.musicService.dashboardSongs(24, this.resolveUserId(context));
  }

  private resolveUserId(context: GqlContext): string | null {
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
}
