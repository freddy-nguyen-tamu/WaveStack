import { Controller, Get, Header, NotFoundException, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { GoogleDriveService } from "./google-drive.service";

@Controller("drive")
export class GoogleDriveController {
  constructor(private readonly googleDriveService: GoogleDriveService) {}

  @Get("stream/:fileId")
  async stream(@Param("fileId") fileId: string, @Res() response: Response): Promise<void> {
    const mediaUrl = this.googleDriveService.getMediaUrl(fileId);
    const upstream = await fetch(mediaUrl);

    if (!upstream.ok || !upstream.body) {
      throw new NotFoundException("Drive file could not be streamed.");
    }

    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
    response.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) {
      response.setHeader("Content-Length", contentLength);
    }

    const reader = upstream.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        response.end();
        return;
      }

      response.write(Buffer.from(value));
    }
  }

  @Get("thumbnail/:fileId")
  @Header("Cache-Control", "public, max-age=3600")
  async thumbnail(@Param("fileId") fileId: string, @Res() response: Response): Promise<void> {
    const mediaUrl = await this.googleDriveService.getImageMediaUrl(fileId);

    if (!mediaUrl) {
      throw new NotFoundException("Drive thumbnail could not be found.");
    }

    const upstream = await fetch(mediaUrl);

    if (!upstream.ok || !upstream.body) {
      throw new NotFoundException("Drive thumbnail could not be loaded.");
    }

    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");

    const reader = upstream.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        response.end();
        return;
      }

      response.write(Buffer.from(value));
    }
  }

  @Get("debug/folders")
  debugFolders() {
    return this.googleDriveService.debugFolders();
  }
}
