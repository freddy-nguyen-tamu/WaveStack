import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { AuthService } from "../auth/auth.service";
import { HabitsService } from "./habits.service";
import {
  DriveExportResult,
  HabitSummaryEntry,
  ListeningStatsEntry,
  ListeningStatsSnapshot,
  PlacementPoint,
  RecentlyPlayedEntry,
  RecommendSongResult
} from "./habits.models";

type GqlContext = {
  req?: {
    headers?: {
      authorization?: string;
    };
  };
};

@Resolver()
export class HabitsResolver {
  constructor(
    private readonly habitsService: HabitsService,
    private readonly authService: AuthService
  ) {}

  private resolveUserId(context: GqlContext): string | null {
    const authHeader = context.req?.headers?.authorization ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      return null;
    }

    try {
      const payload = this.authService.verifyToken(authHeader.slice(7));
      return payload.userId;
    } catch {
      return null;
    }
  }

  @Query(() => [RecommendSongResult])
  async recommendedSongs(
    @Context() context: GqlContext,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("offset", { type: () => Int, nullable: true }) offset?: number,
    @Args("favoriteSongIds", { type: () => [String], nullable: true }) favoriteSongIds?: string[],
    @Args("recentSongIds", { type: () => [String], nullable: true }) recentSongIds?: string[]
  ): Promise<RecommendSongResult[]> {
    const userId = this.resolveUserId(context);

    return this.habitsService.recommendSongs(userId, limit ?? 24, {
      favoriteSongIds: favoriteSongIds ?? [],
      recentSongIds: recentSongIds ?? [],
      offset: offset ?? 0
    });
  }

  @Query(() => [ListeningStatsEntry])
  async topTracks(
    @Context() context: GqlContext,
    @Args("period") period: string,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<ListeningStatsEntry[]> {
    const userId = this.resolveUserId(context);
    if (!userId) return [];
    return this.habitsService.topTracks(userId, period as "FOUR_WEEKS" | "SIX_MONTHS" | "TWELVE_MONTHS" | "ALL_TIME", limit ?? 50);
  }

  @Query(() => [ListeningStatsEntry])
  async topArtists(
    @Context() context: GqlContext,
    @Args("period") period: string,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<ListeningStatsEntry[]> {
    const userId = this.resolveUserId(context);
    if (!userId) return [];
    return this.habitsService.topArtists(userId, period as "FOUR_WEEKS" | "SIX_MONTHS" | "TWELVE_MONTHS" | "ALL_TIME", limit ?? 50);
  }

  @Query(() => [ListeningStatsEntry])
  async topGenres(
    @Context() context: GqlContext,
    @Args("period") period: string,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<ListeningStatsEntry[]> {
    const userId = this.resolveUserId(context);
    if (!userId) return [];
    return this.habitsService.topGenres(userId, period as "FOUR_WEEKS" | "SIX_MONTHS" | "TWELVE_MONTHS" | "ALL_TIME", limit ?? 50);
  }

  @Query(() => [RecentlyPlayedEntry])
  async recentlyPlayedDetailed(
    @Context() context: GqlContext,
    @Args("period") period: string,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<RecentlyPlayedEntry[]> {
    const userId = this.resolveUserId(context);
    if (!userId) return [];
    return this.habitsService.recentlyPlayedDetailed(userId, period as "FOUR_WEEKS" | "SIX_MONTHS" | "TWELVE_MONTHS" | "ALL_TIME", limit ?? 50);
  }

  @Mutation(() => ListeningStatsSnapshot)
  async saveStatsSnapshot(
    @Context() context: GqlContext,
    @Args("label") label: string,
    @Args("period") period: string
  ): Promise<ListeningStatsSnapshot> {
    const userId = this.resolveUserId(context);
    if (!userId) {
      return { id: "", label: "", createdAt: new Date().toISOString(), entries: [] };
    }

    const statsPeriod = period as "FOUR_WEEKS" | "SIX_MONTHS" | "TWELVE_MONTHS" | "ALL_TIME";
    const [tracks, artists, genres] = await Promise.all([
      this.habitsService.topTracks(userId, statsPeriod, 50),
      this.habitsService.topArtists(userId, statsPeriod, 50),
      this.habitsService.topGenres(userId, statsPeriod, 50)
    ]);

    return this.habitsService.saveStatsSnapshot(userId, label, tracks, artists, genres);
  }

  @Query(() => [ListeningStatsSnapshot])
  async previousStatsSnapshots(
    @Context() context: GqlContext
  ): Promise<ListeningStatsSnapshot[]> {
    const userId = this.resolveUserId(context);
    if (!userId) return [];
    return this.habitsService.previousStatsSnapshots(userId);
  }

  @Query(() => [PlacementPoint])
  async placementHistory(
    @Context() context: GqlContext,
    @Args("songId") songId: string
  ): Promise<PlacementPoint[]> {
    const userId = this.resolveUserId(context);
    if (!userId) return [];
    return this.habitsService.placementHistory(userId, songId);
  }

  @Query(() => [HabitSummaryEntry])
  async listeningHabitSummary(
    @Context() context: GqlContext,
    @Args("period") period: "DAY" | "WEEK" | "MONTH" | "YEAR"
  ): Promise<HabitSummaryEntry[]> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return [];
    }

    return this.habitsService.summarize(userId, period);
  }

  @Mutation(() => Boolean)
  async recordListen(
    @Context() context: GqlContext,
    @Args("songId") songId: string,
    @Args("artistName") artistName: string,
    @Args("title") title: string,
    @Args("durationSeconds", { type: () => Int }) durationSeconds: number,
    @Args("completedPlayRatio") completedPlayRatio: number
  ): Promise<boolean> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return false;
    }

    return this.habitsService.recordListen(userId, songId, artistName, title, durationSeconds, completedPlayRatio);
  }

  @Mutation(() => DriveExportResult)
  async testPrivateDriveWrite(): Promise<DriveExportResult> {
    return this.habitsService.testDriveWrite();
  }

  @Mutation(() => DriveExportResult)
  async exportListeningHabits(
    @Context() context: GqlContext,
    @Args("period", { nullable: true }) period?: "DAY" | "WEEK" | "MONTH" | "YEAR" | "ALL"
  ): Promise<DriveExportResult> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return {
        ok: false,
        message: "You must be logged in to export listening habits."
      };
    }

    return this.habitsService.exportToDrive(userId, period ?? "ALL");
  }
}
