import { Controller, Get, Header, Param, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { Readable } from "node:stream";
import { GoogleDriveService } from "./google-drive.service";

@Controller("drive")
export class GoogleDriveController {
  constructor(private readonly googleDriveService: GoogleDriveService) {}

  @Get("debug")
  async debug() {
    const folderIds = this.googleDriveService.folderIds;
    const folders = await Promise.all(
      folderIds.map((id) => this.googleDriveService.getFolderDebug(id))
    );
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
        parentFolderId: file.parentFolderId
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
    const headers: Record<string, string> = {};

    if (request.headers.range) {
      headers.Range = request.headers.range;
    }

    const upstream = await fetch(this.googleDriveService.getMediaUrl(fileId), {
      headers
    });

    const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");

    response.status(upstream.status);
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.setHeader("Accept-Ranges", "bytes");

    if (contentLength) {
      response.setHeader("Content-Length", contentLength);
    }

    if (contentRange) {
      response.setHeader("Content-Range", contentRange);
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
}
