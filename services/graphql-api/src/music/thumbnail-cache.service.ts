import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp = require("sharp");
import { Song } from "./music.models";
import { DriveArtworkService } from "./drive-artwork.service";

export const CURRENT_THUMBNAIL_CACHE_SUFFIX = "-cover-v2.webp";

type RgbaColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

@Injectable()
export class ThumbnailCacheService {
  private readonly logger = new Logger(ThumbnailCacheService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly driveArtworkService: DriveArtworkService
  ) {}

  async generateForSong(song: Song): Promise<string | null> {
    const fileName = `${this.safeFileName(song.id)}${CURRENT_THUMBNAIL_CACHE_SUFFIX}`;
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
    const fileName = `${this.safeFileName(songId)}${CURRENT_THUMBNAIL_CACHE_SUFFIX}`;
    const outputPath = join(this.thumbnailDir, fileName);
    const publicUrl = `${this.publicPath}/${fileName}`;

    await this.writeWebp(outputPath, buffer);
    return publicUrl;
  }

  private async writeWebp(path: string, buffer: Buffer): Promise<void> {
    await mkdir(this.thumbnailDir, { recursive: true });

    const crop = await this.findArtworkContentCrop(buffer);
    let pipeline = sharp(buffer).rotate();

    if (crop) {
      pipeline = pipeline.extract(crop);
    }

    const output = await pipeline
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

  private async findArtworkContentCrop(buffer: Buffer): Promise<sharp.Region | null> {
    try {
      const { data, info } = await sharp(buffer)
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const width = info.width;
      const height = info.height;
      const channels = info.channels;

      if (!width || !height || channels < 4) {
        return null;
      }

      const background = this.averageCornerColor(data, width, height, channels);
      const threshold = 36;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * channels;
          const alpha = data[offset + 3];

          if (alpha <= 18) {
            continue;
          }

          const colorDistance =
            Math.abs(data[offset] - background.r) +
            Math.abs(data[offset + 1] - background.g) +
            Math.abs(data[offset + 2] - background.b);
          const alphaDistance = Math.abs(alpha - background.a);

          if (colorDistance <= threshold && alphaDistance <= threshold) {
            continue;
          }

          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }

      if (maxX < minX || maxY < minY) {
        return null;
      }

      const trimWidth = maxX - minX + 1;
      const trimHeight = maxY - minY + 1;
      const minUsefulWidth = width * 0.18;
      const minUsefulHeight = height * 0.18;

      if (trimWidth < minUsefulWidth || trimHeight < minUsefulHeight) {
        return null;
      }

      const meaningfulInset = Math.min(width, height) * 0.04;
      const hasPaddedEdge =
        minX > meaningfulInset ||
        minY > meaningfulInset ||
        width - maxX - 1 > meaningfulInset ||
        height - maxY - 1 > meaningfulInset;

      if (!hasPaddedEdge) {
        return null;
      }

      const padding = Math.max(2, Math.round(Math.max(trimWidth, trimHeight) * 0.015));
      const left = Math.max(0, minX - padding);
      const top = Math.max(0, minY - padding);
      const right = Math.min(width - 1, maxX + padding);
      const bottom = Math.min(height - 1, maxY + padding);

      return {
        left,
        top,
        width: right - left + 1,
        height: bottom - top + 1
      };
    } catch (error) {
      this.logger.debug(
        `Could not inspect thumbnail padding: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private averageCornerColor(data: Buffer, width: number, height: number, channels: number): RgbaColor {
    const points = [
      [0, 0],
      [Math.max(0, width - 1), 0],
      [0, Math.max(0, height - 1)],
      [Math.max(0, width - 1), Math.max(0, height - 1)]
    ];
    const total = points.reduce(
      (sum, [x, y]) => {
        const offset = (y * width + x) * channels;

        return {
          r: sum.r + data[offset],
          g: sum.g + data[offset + 1],
          b: sum.b + data[offset + 2],
          a: sum.a + data[offset + 3]
        };
      },
      { r: 0, g: 0, b: 0, a: 0 }
    );

    return {
      r: total.r / points.length,
      g: total.g / points.length,
      b: total.b / points.length,
      a: total.a / points.length
    };
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
