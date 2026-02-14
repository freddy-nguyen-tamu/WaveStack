import { Body, Controller, Headers, Post, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ListeningArchiveService } from "./listening-archive.service";

@Controller("maintenance")
export class ListeningArchiveController {
  constructor(
    private readonly config: ConfigService,
    private readonly listeningArchiveService: ListeningArchiveService
  ) {}

  @Post("archive-listening-events")
  archiveListeningEvents(
    @Headers("x-maintenance-token") token: string | undefined,
    @Body() body: { dryRun?: boolean; daysToKeep?: number }
  ) {
    const expected = this.config.get<string>("MAINTENANCE_ARCHIVE_TOKEN");

    if (!expected || token !== expected) {
      throw new UnauthorizedException("Invalid maintenance token.");
    }

    const defaultDays = Number(this.config.get<string>("LISTENING_ARCHIVE_DAYS_TO_KEEP") ?? "180");

    return this.listeningArchiveService.archiveOldEvents({
      daysToKeep: body.daysToKeep ?? defaultDays,
      dryRun: body.dryRun ?? false
    });
  }
}
