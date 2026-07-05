import { Controller, Get, Header, NotFoundException, Param, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DriveArtworkService } from "./drive-artwork.service";
import { DriveDownloadService } from "./drive-download.service";
import { GoogleDriveService } from "./google-drive.service";

@Controller("drive")
export class GoogleDriveController {
  constructor(
    private readonly googleDriveService: GoogleDriveService,
    private readonly driveArtworkService: DriveArtworkService,
    private readonly config: ConfigService,
    private readonly driveDownloadService: DriveDownloadService
  ) {}

  @Get("debug")
  async debug() {
    const folders = await this.googleDriveService.debugFolders();
    const files = await this.googleDriveService.listAllDriveMp3Files();

    return {
      folderCount: folders.length,
      totalMp3Count: files.length,
      folders,
      firstSongs: files.slice(0, 25).map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sourceRootFolderId: file.sourceRootFolderId,
        parentFolderId: file.parentFolderId,
        artworkUrl: `${this.googleDriveService.publicApiOriginForUrls}/drive/artwork/${file.id}`
      }))
    };
  }

  @Get("stream/:fileId")
  @Header("Accept-Ranges", "bytes")
  async stream(
    @Param("fileId") fileId: string,
    @Req() request: Request,
    @Res() response: Response
  ) {
    const upstream = await this.driveDownloadService.fetchMedia(
      fileId,
      request.headers.range as string | undefined
    );

    const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");

    response.status(upstream.status);
    response.setHeader("Content-Type", contentType);
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    response.setHeader("Accept-Ranges", "bytes");

    if (contentLength) {
      response.setHeader("Content-Length", contentLength);
    }

    if (contentRange) {
      response.setHeader("Content-Range", contentRange);
    }

    // IMPORTANT: only cache successful audio responses. This used to be
    // set unconditionally, which meant a transient upstream failure
    // (401/403/5xx from Google Drive) got cached by the browser for a
    // full hour as if it were a valid response. Once that happened, every
    // subsequent play of that same track on that browser failed instantly
    // from the browser's own disk cache -- "Format error" / "no supported
    // source" -- with no new network request ever being sent, until the
    // cache entry expired an hour later. That's why it looked like a
    // memory leak that "went away after a while" and why it only affected
    // whichever browser/device had actually made the failing request.
    if (upstream.ok) {
      response.setHeader("Cache-Control", "public, max-age=3600");
    } else {
      response.setHeader("Cache-Control", "no-store");
    }

    if (!upstream.ok) {
      const body = await upstream.text();
      response.send(body);
      return;
    }

    if (!upstream.body) {
      response.end();
      return;
    }

    Readable.fromWeb(upstream.body as any).pipe(response);
  }

  @Get("artwork/:fileId")
  @Header("Cache-Control", "public, max-age=86400")
  async artwork(@Param("fileId") fileId: string, @Res() response: Response): Promise<void> {
    const artwork = await this.driveArtworkService.getEmbeddedArtwork(fileId);

    if (!artwork) {
      throw new NotFoundException("No embedded artwork was found for this Drive audio file.");
    }

    response.status(200);
    response.setHeader("Content-Type", artwork.contentType);
    response.setHeader("Content-Length", String(artwork.buffer.length));
    response.end(artwork.buffer);
  }

  @Get("assets/thumbnails/:fileName")
  thumbnail(@Param("fileName") fileName: string, @Res() response: Response): void {
    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, "");
    const thumbnailDir = this.config.get<string>("DRIVE_TRACK_SYNC_THUMBNAIL_DIR") ?? "/app/.cache/thumbnails";
    const path = join(thumbnailDir, safeName);

    if (!existsSync(path) || !safeName.endsWith(".webp")) {
      response.status(404).send("Thumbnail not found.");
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "image/webp");
    response.setHeader("Cache-Control", "public, max-age=604800, immutable");
    createReadStream(path).pipe(response);
  }
}
