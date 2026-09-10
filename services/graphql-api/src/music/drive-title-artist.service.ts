import { Injectable, Logger } from "@nestjs/common";
import { parseBuffer, parseFile, type IAudioMetadata } from "music-metadata";
import { join } from "path";
import { DriveDownloadService } from "./drive-download.service";
import { embeddedSearchText } from "./embedded-search-text";

export type EmbeddedTitleArtist = {
  title: string | null;
  artist: string | null;
  searchText: string;
};

const TEN_MINUTES_MS = 10 * 60 * 1000;

/*
  Reads the ACTUAL embedded ID3 (or MP4/FLAC) tags from a Drive audio file,
  as opposed to google-drive.service.ts's parseSongName(), which only ever
  guesses a title/artist by splitting the raw Drive filename on " - ".

  Filenames downloaded from YouTube-rippers, Zing MP3, etc. almost never
  match "Artist - Title" and often contain the *title* first followed by
  a bunch of tags like "(Bản Cực Căng) - Remix Hot [videoId]", which is
  why the filename parser regularly produces swapped / garbled results.
  The real title (TIT2) and artist (TPE1) are usually embedded correctly
  in the file itself, so prefer those whenever they're present.
*/
@Injectable()
export class DriveTitleArtistService {
  private readonly logger = new Logger(DriveTitleArtistService.name);
  private readonly cache = new Map<string, { value: EmbeddedTitleArtist | null; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<EmbeddedTitleArtist | null>>();

  constructor(private readonly driveDownloadService: DriveDownloadService) {}

  async getEmbeddedTitleArtist(fileId: string, modifiedTime?: string, streamUrl?: string): Promise<EmbeddedTitleArtist | null> {
    const cacheKey = `${fileId}:${modifiedTime ?? ""}`;
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const pending = this.pending.get(cacheKey);
    if (pending) return pending;

    const request = (async () => {
      const uploadName = streamUrl?.match(/^\/api\/uploads\/([a-zA-Z0-9_.-]+)$/)?.[1];
      const value = uploadName && uploadName !== "." && uploadName !== ".."
        ? this.readTags(await parseFile(join("/app/uploads", uploadName), { duration: false, skipCovers: true }))
        : await this.loadEmbeddedTitleArtist(fileId);

      // Search text can include long lyrics; don't retain the entire library in RAM.
      this.cache.delete(cacheKey);
      while (this.cache.size >= 128) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, { value, expiresAt: Date.now() + TEN_MINUTES_MS });
      return value;
    })().finally(() => this.pending.delete(cacheKey));
    this.pending.set(cacheKey, request);
    return request;
  }

  private async loadEmbeddedTitleArtist(fileId: string): Promise<EmbeddedTitleArtist | null> {
    const signal = AbortSignal.timeout(30000);
    const upstream = await this.driveDownloadService.fetchMedia(fileId, undefined, signal);

    if (!upstream.ok) {
      this.logger.warn(
        `Could not download Drive audio for title/artist tags. fileId=${fileId} status=${upstream.status}`
      );
      await upstream.body?.cancel();
      throw new Error(`Could not read embedded metadata: HTTP ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    try {
      // skipCovers: true -- we only need text frames (TIT2/TPE1) here, so
      // there's no reason to also decode the embedded picture frame.
      const metadata = await parseBuffer(buffer, contentType, {
        duration: false,
        skipCovers: true
      });

      return this.readTags(metadata);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not parse embedded tags for Drive file ${fileId}: ${message}`);
      throw error;
    }
  }

  private clean(value: string | undefined | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private readTags(metadata: IAudioMetadata): EmbeddedTitleArtist {
    return {
      title: this.clean(metadata.common.title),
      artist: this.clean(metadata.common.artist) ?? this.clean(metadata.common.artists?.join(", ")),
      searchText: embeddedSearchText(metadata)
    };
  }
}
