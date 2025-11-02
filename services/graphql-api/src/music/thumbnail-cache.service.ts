import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { Song } from "./music.models";
import { DriveArtworkService } from "./drive-artwork.service";

@Injectable()
export class ThumbnailCacheService {
  private readonly logger = new Logger(ThumbnailCacheService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly driveArtworkService: DriveArtworkService
  ) {}

  async generateForSong(song: Song): Promise<string | null> {
    const fileName = `${this.safeFileName(song.id)}.webp`;
    const outputPath = join(this.thumbnailDir, fileName);
    const publicUrl = `${this.publicPath}/${fileName}`;

    if (existsSync(outputPath)) {
      return publicUrl;
    }

    const rawFileId = song.id.replace(/^drive-/, "");

    try {
      const embedded = await this.driveArtworkService.getEmbeddedArtwork(rawFileId);

      if (embedded?.buffer?.length) {
        await this.writeWebp(outputPath, embedded.buffer);
        return publicUrl;
      }
    } catch (error) {
      this.logger.debug(`No embedded artwork for ${song.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const fallbackUrl = song.driveThumbnailUrl ?? song.thumbnailUrl;

    if (!fallbackUrl || fallbackUrl.includes("/assets/thumbnails/")) {
      return null;
    }

    try {
      const response = await fetch(fallbackUrl);

      if (!response.ok) {
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await this.writeWebp(outputPath, buffer);
      return publicUrl;
    } catch (error) {
      this.logger.debug(`Could not make thumbnail for ${song.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async writeWebp(path: string, buffer: Buffer): Promise<void> {
    await mkdir(this.thumbnailDir, { recursive: true });

    const output = await sharp(buffer)
      .rotate()
      .resize(512, 512, {
        fit: "cover",
        withoutEnlargement: false
      })
      .webp({
        quality: 76,
        effort: 4
      })
      .toBuffer();

    await writeFile(path, output);
  }

  private safeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private get thumbnailDir(): string {
    return this.config.get<string>("DRIVE_TRACK_SYNC_THUMBNAIL_DIR") ?? "/app/.cache/thumbnails";
  }

  private get publicPath(): string {
    return this.config.get<string>("DRIVE_TRACK_SYNC_THUMBNAIL_PUBLIC_PATH") ?? "/drive/assets/thumbnails";
  }
}
