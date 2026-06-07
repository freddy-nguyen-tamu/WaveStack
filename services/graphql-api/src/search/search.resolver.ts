import { Args, Context, Int, Query, Resolver } from "@nestjs/graphql";
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
export class SearchResolver {
  constructor(
    private readonly musicService: MusicService,
    private readonly authService: AuthService
  ) {}

  @Query(() => [Song])
  async search(
    @Context() context: GqlContext,
    @Args("query") query: string,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<Song[]> {
    const page = await this.musicService.songPage(limit ?? 50, null, query, this.resolveUserId(context));
    return page.nodes;
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
