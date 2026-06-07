import {
  BadRequestException,
  Controller, Get, Header, NotFoundException, Param, Post, Req, Res, UnauthorizedException, UploadedFile, UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { access, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthService } from "../auth/auth.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { AudioJobsProducer } from "./audio-jobs.producer";

const UPLOADS_DIR = "/app/uploads";

function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

@Controller("api")
export class UploadsController {
  constructor(
    private readonly authService: AuthService,
    private readonly driveTrackRepository: DriveTrackRepository,
    private readonly audioJobsProducer: AudioJobsProducer
  ) {
    ensureUploadsDir();
  }

  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { dest: UPLOADS_DIR }))
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Req() request: Request,
    @Res() response: Response
  ) {
    if (!file) {
      throw new BadRequestException("No file uploaded.");
    }

    const authHeader = request.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException("Authentication required.");
    }

    let userId: string;
    try {
      userId = this.authService.verifyToken(authHeader.slice(7)).userId;
    } catch {
      throw new UnauthorizedException("Invalid token.");
    }

    const title = (request.body?.title as string)?.trim() || file.originalname.replace(/\.[^/.]+$/, "");
    const artistName = (request.body?.artistName as string)?.trim() || "Unknown Artist";
    const albumTitle = (request.body?.albumTitle as string)?.trim() || "Local Uploads";

    const ext = file.originalname.split(".").pop() ?? "mp3";
    const storedName = `${Date.now()}-${sanitizeFileName(file.originalname)}`;
    const destPath = join(UPLOADS_DIR, storedName);

    if (file.path && file.path !== destPath) {
      await access(file.path);
      await writeFile(destPath, await require("node:fs/promises").readFile(file.path));
      await unlink(file.path).catch(() => {});
    }

    const streamUrl = `/api/uploads/${storedName}`;

    const song = await this.driveTrackRepository.createUserSongs(userId, [
      { title, artistName, albumTitle, durationSeconds: 0, streamUrl }
    ]);

    const created = song[0];
    if (!created) {
      throw new BadRequestException("Could not create song record.");
    }

    await this.audioJobsProducer.enqueueAudioProcessing({
      songId: created.id,
      blobUrl: streamUrl,
      requestedByUserId: userId
    });

    response.status(201).json(created);
  }

  @Get("uploads/:fileName")
  @Header("Accept-Ranges", "bytes")
  streamUpload(@Param("fileName") fileName: string, @Req() request: Request, @Res() response: Response) {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "");
    const filePath = join(UPLOADS_DIR, safeName);

    if (!existsSync(filePath) || !safeName) {
      throw new NotFoundException("Uploaded file not found.");
    }

    const stat = require("node:fs").statSync(filePath);
    const fileSize = stat.size;
    const range = request.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(filePath, { start, end });
      response.status(206);
      response.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Length", chunkSize);
      response.setHeader("Content-Type", "audio/mpeg");
      stream.pipe(response);
    } else {
      response.setHeader("Content-Type", "audio/mpeg");
      response.setHeader("Content-Length", fileSize);
      createReadStream(filePath).pipe(response);
    }
  }
}
