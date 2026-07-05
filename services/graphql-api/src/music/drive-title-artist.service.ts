import { Injectable, Logger } from "@nestjs/common";
import { parseBuffer } from "music-metadata";
import { DriveDownloadService } from "./drive-download.service";

export type EmbeddedTitleArtist = {
  title: string | null;
  artist: string | null;
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

  constructor(private readonly driveDownloadService: DriveDownloadService) {}

  async getEmbeddedTitleArtist(fileId: string): Promise<EmbeddedTitleArtist | null> {
    const cached = this.cache.get(fileId);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = await this.loadEmbeddedTitleArtist(fileId);

    this.cache.set(fileId, {
      value,
      expiresAt: Date.now() + TEN_MINUTES_MS
    });

    return value;
  }

  private async loadEmbeddedTitleArtist(fileId: string): Promise<EmbeddedTitleArtist | null> {
    const upstream = await this.driveDownloadService.fetchMedia(fileId);

    if (!upstream.ok) {
      this.logger.warn(
        `Could not download Drive audio for title/artist tags. fileId=${fileId} status=${upstream.status}`
      );
      return null;
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

      const title = this.clean(metadata.common.title);
      const artist = this.clean(metadata.common.artist);

      if (!title && !artist) {
        this.logger.debug(`No embedded title/artist tags found in Drive file ${fileId}.`);
        return null;
      }

      return { title, artist };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not parse embedded tags for Drive file ${fileId}: ${message}`);
      return null;
    }
  }

  private clean(value: string | undefined | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }
}
