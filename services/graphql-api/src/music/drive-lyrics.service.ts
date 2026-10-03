import { Injectable, Logger } from "@nestjs/common";
import { parseBuffer, type IAudioMetadata, type INativeTagDict } from "music-metadata";
import { DriveDownloadService } from "./drive-download.service";

type NativeTag = {
  id?: string;
  value?: unknown;
};

const TEN_MINUTES_MS = 10 * 60 * 1000;
const MP3_PREFIX_BYTES = 512 * 1024;
const MP3_TAG_TRAILER_BYTES = 64 * 1024;
const MAX_FAST_ID3_BYTES = 24 * 1024 * 1024;

@Injectable()
export class DriveLyricsService {
  private readonly logger = new Logger(DriveLyricsService.name);
  private readonly cache = new Map<string, { value: string | null; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(private readonly driveDownloadService: DriveDownloadService) {}

  async getEmbeddedLyrics(fileId: string): Promise<string | null> {
    const cached = this.cache.get(fileId);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const existing = this.pending.get(fileId);
    if (existing) return existing;

    const request = this.loadEmbeddedLyrics(fileId)
      .then(value => {
        this.cache.set(fileId, {
          value,
          expiresAt: Date.now() + TEN_MINUTES_MS
        });
        return value;
      })
      .finally(() => this.pending.delete(fileId));

    this.pending.set(fileId, request);
    return request;
  }

  private async loadEmbeddedLyrics(fileId: string): Promise<string | null> {
    // MP3 ID3v2 text frames live at the beginning of the file. Reading a small
    // byte range first avoids downloading an entire multi-megabyte song just to
    // obtain USLT/SYLT lyrics. If the ID3 header declares a larger tag (often
    // because it contains cover art), fetch only that tag plus a small trailer.
    const prefix = await this.driveDownloadService.fetchMedia(
      fileId,
      `bytes=0-${MP3_PREFIX_BYTES - 1}`,
      AbortSignal.timeout(8000)
    );

    if (!prefix.ok) {
      this.logger.warn(`Could not download Drive audio prefix for lyrics. fileId=${fileId} status=${prefix.status}`);
      await prefix.body?.cancel();
      return null;
    }

    const contentType = prefix.headers.get("content-type") ?? "audio/mpeg";
    const prefixBuffer = Buffer.from(await prefix.arrayBuffer());
    const rangeWasHonored = prefix.status === 206 || Boolean(prefix.headers.get("content-range"));

    // Some upstreams ignore Range and return the whole file. In that case we
    // already paid for the bytes, so parse the complete response directly.
    if (!rangeWasHonored) {
      return this.parseLyrics(prefixBuffer, contentType, fileId);
    }

    const id3Length = this.id3v2Length(prefixBuffer);
    const looksLikeMp3 =
      id3Length !== null ||
      /(?:audio\/(?:mpeg|mp3)|application\/octet-stream)/i.test(contentType);

    if (looksLikeMp3) {
      if (id3Length === null) {
        // Unsynchronised/synchronised embedded MP3 lyrics are ID3v2 frames. No
        // ID3v2 header means there is nothing useful to gain by downloading the
        // entire audio payload on every modal open.
        return null;
      }

      let metadataBuffer = prefixBuffer;
      if (id3Length > prefixBuffer.length && id3Length <= MAX_FAST_ID3_BYTES) {
        const end = Math.min(
          MAX_FAST_ID3_BYTES - 1,
          id3Length + MP3_TAG_TRAILER_BYTES - 1
        );
        const tagResponse = await this.driveDownloadService.fetchMedia(
          fileId,
          `bytes=0-${end}`,
          AbortSignal.timeout(10000)
        );

        if (tagResponse.ok) {
          metadataBuffer = Buffer.from(await tagResponse.arrayBuffer());
        } else {
          await tagResponse.body?.cancel();
        }
      }

      return this.parseLyrics(metadataBuffer, contentType, fileId);
    }

    // FLAC/MP4 and other formats can keep metadata outside the leading range.
    // Preserve correctness for those less-common files with the old full-file
    // path while MP3s take the much faster bounded-range path above.
    const upstream = await this.driveDownloadService.fetchMedia(
      fileId,
      undefined,
      AbortSignal.timeout(20000)
    );

    if (!upstream.ok) {
      this.logger.warn(`Could not download Drive audio for lyrics. fileId=${fileId} status=${upstream.status}`);
      await upstream.body?.cancel();
      return null;
    }

    return this.parseLyrics(Buffer.from(await upstream.arrayBuffer()), contentType, fileId);
  }

  private id3v2Length(buffer: Buffer): number | null {
    if (buffer.length < 10 || buffer.subarray(0, 3).toString("ascii") !== "ID3") {
      return null;
    }

    const size =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    const footerBytes = (buffer[5] & 0x10) !== 0 ? 10 : 0;
    return 10 + size + footerBytes;
  }

  private async parseLyrics(buffer: Buffer, contentType: string, fileId: string): Promise<string | null> {
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
