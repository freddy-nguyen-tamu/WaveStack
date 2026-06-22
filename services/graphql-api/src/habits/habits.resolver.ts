import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { AuthService } from "../auth/auth.service";
import { HabitsService } from "./habits.service";
import { GroqTasteService } from "./groq-taste.service";
import { ListeningArchiveService } from "./listening-archive.service";
import {
  ArchiveReadThroughStatus,
  ArchiveWarmResult,
  DriveExportResult,
  GroqDebugStatus,
  HabitSummaryEntry,
  ListeningArchiveResult,
  ListeningArchiveStatus,
  ListeningStatsEntry,
  ListeningStatsSnapshot,
  PlacementPoint,
  RecentlyPlayedEntry,
  RecommendSongResult,
  RecommendedSongsPage,
  TasteComparisonResult,
  TasteJudgeResult
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
    private readonly authService: AuthService,
    private readonly groqTasteService: GroqTasteService,
    private readonly listeningArchiveService: ListeningArchiveService
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

  @Query(() => RecommendedSongsPage)
  async recommendedSongs(
    @Context() context: GqlContext,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("offset", { type: () => Int, nullable: true }) offset?: number,
    @Args("favoriteSongIds", { type: () => [String], nullable: true }) favoriteSongIds?: string[],
    @Args("recentSongIds", { type: () => [String], nullable: true }) recentSongIds?: string[],
    @Args("excludedSongIds", { type: () => [String], nullable: true }) excludedSongIds?: string[]
  ): Promise<RecommendedSongsPage> {
    const userId = this.resolveUserId(context);

    return this.habitsService.recommendSongsPage(userId, {
      limit: limit ?? 24,
      offset: offset ?? 0,
      favoriteSongIds: favoriteSongIds ?? [],
      recentSongIds: recentSongIds ?? [],
      excludedSongIds: excludedSongIds ?? []
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
    @Args("statType") statType: string,
    @Args("period") period: string,
    @Args("label") label: string
  ): Promise<ListeningStatsSnapshot> {
    const userId = this.resolveUserId(context);
    if (!userId) {
      return { id: "", statType: "", period: "", label: "", generatedAt: new Date().toISOString(), entries: [] };
    }

    const statsPeriod = period as "FOUR_WEEKS" | "SIX_MONTHS" | "TWELVE_MONTHS" | "ALL_TIME";
    const entries = await this.habitsService.topTracks(userId, statsPeriod, 50);

    return this.habitsService.saveStatsSnapshot(userId, statType, period, label, entries);
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
    @Args("key") key: string
  ): Promise<PlacementPoint[]> {
    const userId = this.resolveUserId(context);
    if (!userId) return [];
    return this.habitsService.placementHistory(userId, key);
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

  @Query(() => TasteComparisonResult)
  tasteComparison(
    @Context() context: GqlContext,
    @Args("period", { nullable: true }) period?: string
  ): Promise<TasteComparisonResult> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return Promise.resolve({
        userPlayCount: 0,
        libraryUserCount: 0,
        obscurityScore: 0,
        mainstreamScore: 0,
        uniquenessScore: 0,
        overlapScore: 0,
        rareArtists: [],
        commonArtists: []
      });
    }

    return this.habitsService.tasteComparison(userId, period ?? "ALL_TIME");
  }

  @Mutation(() => TasteJudgeResult)
  judgeTaste(
    @Context() context: GqlContext,
    @Args("period", { nullable: true }) period?: string,
    @Args("writingStylePhrase", { nullable: true }) writingStylePhrase?: string,
    @Args("writingStyleExample", { nullable: true }) writingStyleExample?: string
  ): Promise<TasteJudgeResult> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return Promise.resolve({
        ok: false,
        verdictTitle: "Sign in first",
        roast: "I cannot judge a ghost. Sign in and play some music first.",
        summary: "WaveStack needs logged-in listening events before judging taste.",
        badges: ["Invisible listener"],
        tasteScore: 0,
        obscurityScore: 0,
        chaosScore: 0,
        generatedAt: new Date().toISOString()
      });
    }

    return this.habitsService.judgeTaste(userId, period ?? "ALL_TIME", {
      phrase: writingStylePhrase,
      example: writingStyleExample
    });
  }

  @Query(() => GroqDebugStatus)
  groqDebugStatus(): GroqDebugStatus {
    const configuredKeyNames = this.groqTasteService.configuredKeyNames();

    return {
      model: this.groqTasteService.configuredModel(),
      configuredKeyCount: configuredKeyNames.length,
      configuredKeyNames
    };
  }

  @Query(() => ListeningArchiveStatus)
  listeningArchiveStatus(@Context() context: GqlContext): Promise<ListeningArchiveStatus> {
    const userId = this.resolveUserId(context);
    return this.listeningArchiveService.status(userId ?? undefined);
  }

  @Mutation(() => ListeningArchiveResult)
  archiveOldListeningEvents(
    @Context() context: GqlContext,
    @Args("daysToKeep", { type: () => Int, nullable: true }) daysToKeep?: number,
    @Args("dryRun", { nullable: true }) dryRun?: boolean
  ): Promise<ListeningArchiveResult> {
    const userId = this.resolveUserId(context);

    if (!userId) {
      return Promise.resolve({
        ok: false,
        message: "You must be logged in to archive listening habits.",
        exportedEventCount: 0,
        deletedEventCount: 0,
        driveFileCount: 0,
        cutoffAt: new Date().toISOString(),
        errorMessage: "Not authenticated"
      });
    }

    return this.listeningArchiveService.archiveOldEvents({
      userId,
      daysToKeep: daysToKeep ?? 30,
      dryRun: dryRun ?? true
    });
  }

  @Query(() => ArchiveReadThroughStatus)
  async listeningArchiveReadThroughStatus(@Context() context: GqlContext): Promise<ArchiveReadThroughStatus> {
    const userId = this.resolveUserId(context);
    if (!userId) {
      return {
        readThroughEnabled: false,
        deleteAfterExport: false,
        archiveFileCount: 0,
        cachedArchiveFileCount: 0,
        cachedEventCount: 0,
        message: "Not authenticated"
      };
    }
    return this.listeningArchiveService.getReadThroughStatus(userId);
  }

  @Mutation(() => ArchiveWarmResult)
  async warmListeningArchiveCache(
    @Context() context: GqlContext,
    @Args("period", { type: () => String, nullable: true }) period?: string,
    @Args("force", { type: () => Boolean, nullable: true }) force?: boolean
  ): Promise<ArchiveWarmResult> {
    const userId = this.resolveUserId(context);
    if (!userId) {
      return { ok: false, message: "Not authenticated", filesScanned: 0, filesRead: 0, eventsCached: 0, skippedFiles: 0, errors: ["Not authenticated"] };
    }
    return this.listeningArchiveService.warmArchiveCacheForPeriod(userId, period ?? "ALL_TIME", Boolean(force));
  }
}
