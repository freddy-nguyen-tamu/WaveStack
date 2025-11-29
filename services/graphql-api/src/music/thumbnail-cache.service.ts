import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp = require("sharp");
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

    const fallbackUrl = this.firstUsableUrl([
      song.driveThumbnailUrl,
      song.thumbnailUrl
    ]);

    if (fallbackUrl) {
      const madeFromDriveThumbnail = await this.tryGenerateFromUrl(outputPath, fallbackUrl, song.id);

      if (madeFromDriveThumbnail) {
        return publicUrl;
      }
    }

    /*
      Do not download full audio files during the main library sync.

      For a 3,000+ song Drive library, trying to download every MP3 just to
      inspect embedded artwork is too slow and often fails with 403. The main
      sync should only generate thumbnails from cheap image URLs such as
      Drive thumbnailLink. Songs without a usable thumbnail URL fall back to
      the normal letter artwork in the UI.
    */
    return null;
  }

  private async tryGenerateFromUrl(
    outputPath: string,
    url: string,
    songId: string
  ): Promise<boolean> {
    try {
      const response = await this.withTimeout(
        fetch(url, {
          headers: {
            "user-agent": "WaveStack/1.0"
          }
        }),
        12000
      );

      if (!response.ok) {
        this.logger.debug(`Thumbnail URL failed for ${songId}: ${response.status}`);
        return false;
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (contentType && !contentType.toLowerCase().startsWith("image/")) {
        this.logger.debug(`Thumbnail URL for ${songId} was not an image: ${contentType}`);
        return false;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (!buffer.length) {
        return false;
      }

      await this.writeWebp(outputPath, buffer);
      return true;
    } catch (error) {
      this.logger.debug(
        `Could not generate thumbnail from URL for ${songId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
  }

  async writeEmbeddedArtwork(songId: string, buffer: Buffer): Promise<string | null> {
    const fileName = `${this.safeFileName(songId)}.webp`;
    const outputPath = join(this.thumbnailDir, fileName);
    const publicUrl = `${this.publicPath}/${fileName}`;

    await this.writeWebp(outputPath, buffer);
    return publicUrl;
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
        effort: 3
      })
      .toBuffer();

    await writeFile(path, output);
  }

  private firstUsableUrl(urls: Array<string | null | undefined>): string | null {
    for (const url of urls) {
      const trimmed = url?.trim();

      if (!trimmed) {
        continue;
      }

      if (trimmed.includes("/assets/thumbnails/")) {
        continue;
      }

      if (trimmed.includes("/drive/assets/thumbnails/")) {
        continue;
      }

      return trimmed;
    }

    return null;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Timed out after ${ms}ms`));
      }, ms);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
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