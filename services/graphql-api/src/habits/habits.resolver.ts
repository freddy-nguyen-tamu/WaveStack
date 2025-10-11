import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { AuthService } from "../auth/auth.service";
import { HabitsService } from "./habits.service";
import { DriveExportResult, HabitSummaryEntry, RecommendSongResult } from "./habits.models";

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
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<RecommendSongResult[]> {
    const userId = this.resolveUserId(context);
    return this.habitsService.recommendSongs(userId, limit ?? 24);
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
