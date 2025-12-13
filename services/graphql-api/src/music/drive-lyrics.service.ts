import { Injectable, Logger } from "@nestjs/common";
import { parseBuffer, type IAudioMetadata, type INativeTagDict } from "music-metadata";
import { DriveDownloadService } from "./drive-download.service";

type NativeTag = {
  id?: string;
  value?: unknown;
};

const TEN_MINUTES_MS = 10 * 60 * 1000;

@Injectable()
export class DriveLyricsService {
  private readonly logger = new Logger(DriveLyricsService.name);
  private readonly cache = new Map<string, { value: string | null; expiresAt: number }>();

  constructor(private readonly driveDownloadService: DriveDownloadService) {}

  async getEmbeddedLyrics(fileId: string): Promise<string | null> {
    const cached = this.cache.get(fileId);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = await this.loadEmbeddedLyrics(fileId);

    this.cache.set(fileId, {
      value,
      expiresAt: Date.now() + TEN_MINUTES_MS
    });

    return value;
  }

  private async loadEmbeddedLyrics(fileId: string): Promise<string | null> {
    const upstream = await this.driveDownloadService.fetchMedia(fileId);

    if (!upstream.ok) {
      this.logger.warn(`Could not download Drive audio for lyrics. fileId=${fileId} status=${upstream.status}`);
      return null;
    }

    const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    try {
      const metadata = await parseBuffer(buffer, contentType, {
        duration: false,
        skipCovers: true
      });

      const lyrics = this.extractLyrics(metadata);

      if (!lyrics) {
        this.logger.debug(`No embedded lyrics found in Drive file ${fileId}.`);
        return null;
      }

      return lyrics;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not parse embedded lyrics for Drive file ${fileId}: ${message}`);
      return null;
    }
  }

  private extractLyrics(metadata: IAudioMetadata): string | null {
    const commonLyrics = this.extractCommonLyrics(
      (metadata.common as unknown as { lyrics?: unknown }).lyrics
    );

    if (commonLyrics) {
      return commonLyrics;
    }

    return this.extractNativeLyrics(metadata.native);
  }

  private extractCommonLyrics(value: unknown): string | null {
    if (!value) {
      return null;
    }

    if (typeof value === "string") {
      return this.cleanLyrics(value);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const text = this.extractTextValue(item);

        if (text) {
          return text;
        }
      }
    }

    return null;
  }

  private extractNativeLyrics(native: INativeTagDict): string | null {
    const allTags = Object.values(native).flat() as NativeTag[];

    const preferredTags = allTags.filter((tag) => {
      const id = String(tag.id ?? "").toUpperCase();
      return (
        id === "USLT" ||
        id === "SYLT" ||
        id.includes("UNSYNCEDLYRICS") ||
        id.includes("SYNCEDLYRICS") ||
        id.includes("LYRICS")
      );
    });

    for (const tag of preferredTags) {
      const text = this.extractTextValue(tag.value);

      if (text) {
        return text;
      }
    }

    return null;
  }

  private extractTextValue(value: unknown): string | null {
    if (!value) {
      return null;
    }

    if (typeof value === "string") {
      return this.cleanLyrics(value);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const text = this.extractTextValue(item);

        if (text) {
          return text;
        }
      }

      return null;
    }

    if (typeof value === "object") {
      const record = value as Record<string, unknown>;

      const candidates = [
        record.text,
        record.lyrics,
        record.value,
        record.description
      ];

      for (const candidate of candidates) {
        const text = this.extractTextValue(candidate);

        if (text) {
          return text;
        }
      }
    }

    return null;
  }

  private cleanLyrics(value: string): string | null {
    const cleaned = value
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();

    return cleaned || null;
  }
}
