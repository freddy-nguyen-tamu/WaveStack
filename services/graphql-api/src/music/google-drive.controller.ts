import { Controller, Get, Header, Param, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { Readable } from "node:stream";
import { GoogleDriveService } from "./google-drive.service";

@Controller("drive")
export class GoogleDriveController {
  constructor(private readonly googleDriveService: GoogleDriveService) {}

  @Get("stream/:fileId")
  @Header("Accept-Ranges", "bytes")
  async stream(@Param("fileId") fileId: string, @Req() request: Request, @Res() response: Response) {
    const headers: Record<string, string> = {};

    if (request.headers.range) {
      headers.Range = request.headers.range;
    }

    const upstream = await fetch(this.googleDriveService.getMediaUrl(fileId), { headers });

    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.setHeader("Accept-Ranges", "bytes");

    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");

    if (contentLength) response.setHeader("Content-Length", contentLength);
    if (contentRange) response.setHeader("Content-Range", contentRange);

    if (!upstream.body) {
      response.end();
      return;
    }

    Readable.fromWeb(upstream.body as any).pipe(response);
  }
}
