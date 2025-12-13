import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { parseBuffer } from "music-metadata";
import { DriveDownloadService } from "./drive-download.service";

export type DriveArtwork = {
  buffer: Buffer;
  contentType: string;
};

type ArtworkCacheEntry = {
  expiresAt: number;
  value: DriveArtwork | null;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/*
  This service intentionally reads artwork from the audio file itself.

  Do not use Google Drive's thumbnailLink as the primary song image:
  - Drive thumbnails can be generic.
  - Drive thumbnails can repeat for many files.
  - Drive thumbnails often do not expose embedded MP3 album art.
  - Folder/image matching can accidentally apply the same image to many songs.

  This service parses the embedded ID3/MP4/FLAC picture and caches the result
  in memory so each Drive song gets its own unique artwork endpoint.
*/
@Injectable()
export class DriveArtworkService {
  private readonly logger = new Logger(DriveArtworkService.name);
  private readonly cache = new Map<string, ArtworkCacheEntry>();

  constructor(
    private readonly config: ConfigService,
    private readonly driveDownloadService: DriveDownloadService
  ) {}

  async getEmbeddedArtwork(fileId: string): Promise<DriveArtwork | null> {
    const cached = this.cache.get(fileId);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = await this.loadEmbeddedArtwork(fileId);
    this.cache.set(fileId, {
      value,
      expiresAt: Date.now() + ONE_DAY_MS
    });

    return value;
  }

  private async loadEmbeddedArtwork(fileId: string): Promise<DriveArtwork | null> {
    const upstream = await this.driveDownloadService.fetchMedia(fileId);

    if (!upstream.ok) {
      this.logger.warn(
        `Could not download Drive audio for artwork. fileId=${fileId} status=${upstream.status}`
      );
      return null;
    }

    const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";
    const arrayBuffer = await upstream.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    try {
      const metadata = await parseBuffer(audioBuffer, contentType, {
        duration: false,
        skipCovers: false
      });

      const picture = metadata.common.picture?.[0];

      if (!picture?.data?.length) {
        this.logger.debug(`No embedded artwork found in Drive file ${fileId}.`);
        return null;
      }

      return {
        buffer: Buffer.from(picture.data),
        contentType: picture.format || "image/jpeg"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not parse embedded artwork for Drive file ${fileId}: ${message}`);
      return null;
    }
  }
}
