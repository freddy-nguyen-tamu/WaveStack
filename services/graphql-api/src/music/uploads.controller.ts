import {
  BadRequestException,
  Controller, Get, Header, Logger, NotFoundException, Param, Post, Req, Res, UnauthorizedException, UploadedFile, UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { Request, Response } from "express";
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";
import { AuthService } from "../auth/auth.service";
import { DriveTrackRepository } from "./drive-track.repository";
import { AudioJobsProducer } from "./audio-jobs.producer";

const UPLOADS_DIR = "/app/uploads";
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".flac",
  ".m4a",
  ".m4b",
  ".mp3",
  ".mp4",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".weba",
  ".webm",
  ".wma"
]);

type UploadedAudioMetadata = {
  duration?: number | null;
  title?: string;
  artistName?: string;
  albumTitle?: string;
  genreNames?: string[];
  lyrics?: string;
};

type FilenameMetadata = {
  title?: string;
  artistName?: string;
  albumTitle?: string;
};

function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

ensureUploadsDir();

@Controller("api")
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly driveTrackRepository: DriveTrackRepository,
    private readonly audioJobsProducer: AudioJobsProducer
  ) {}

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: UPLOADS_DIR,
        filename: (_req: any, file: { originalname: string }, callback: (err: Error | null, name: string) => void) => {
          const prefix = Date.now();
          const sanitized = sanitizeFileName(file.originalname);
          callback(null, `${prefix}-${sanitized}`);
        }
      }),
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1
      },
      fileFilter: (_req, file, callback) => {
        const lowerName = file.originalname.toLowerCase();
        const extension = extname(lowerName);
        const looksLikeAudio = file.mimetype.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension);

        if (!looksLikeAudio) {
          callback(new BadRequestException("Choose an audio file. Supported formats include MP3, M4A, WAV, FLAC, OGG, OPUS, WEBM, AAC, and MP4 audio."), false);
          return;
        }

        callback(null, true);
      }
    })
  )
  async uploadFile(
    @UploadedFile() file: any,
    @Req() request: Request,
    @Res() response: Response
  ) {
    const authHeader = request.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      this.deleteUploadedFile(file);
      throw new UnauthorizedException("Authentication required.");
    }

    let userId: string;
    try {
      userId = this.authService.verifyToken(authHeader.slice(7)).userId;
    } catch {
      this.deleteUploadedFile(file);
      throw new UnauthorizedException("Invalid token.");
    }

    if (!file) {
      throw new BadRequestException("No file uploaded.");
    }

    let metadata: UploadedAudioMetadata;
    try {
      metadata = await this.readAudioMetadata(file.path);
    } catch {
      this.deleteUploadedFile(file);
      throw new BadRequestException("That file was saved by the browser, but it is not readable as audio. Try MP3, M4A, WAV, FLAC, OGG, OPUS, WEBM, AAC, or MP4 audio.");
    }

    const filenameMetadata = this.readFilenameMetadata(file.originalname);
    const fileStem = this.fileStem(file.originalname);
    const bodyTitle = this.cleanText(request.body?.title as string);
    const bodyArtist = this.cleanText(request.body?.artistName as string);
    const bodyAlbum = this.cleanText(request.body?.albumTitle as string);
    const title = this.preferBodyValue(bodyTitle, fileStem) ?? metadata.title ?? filenameMetadata.title ?? fileStem;
    const artistName = this.preferBodyValue(bodyArtist, "Local Upload") ?? metadata.artistName ?? filenameMetadata.artistName ?? "Unknown Artist";
    const albumTitle = this.preferBodyValue(bodyAlbum, "Local Uploads") ?? metadata.albumTitle ?? filenameMetadata.albumTitle ?? "Local Uploads";
    const durationSeconds = metadata.duration ? Math.max(0, Math.round(metadata.duration)) : 0;

    const streamUrl = `/api/uploads/${file.filename}`;

    let created;

    try {
      const song = await this.driveTrackRepository.createUserSongs(userId, [
        {
          title,
          artistName,
          albumTitle,
          durationSeconds,
          streamUrl,
          genreNames: metadata.genreNames ?? [],
          lyrics: metadata.lyrics
        }
      ]);

      created = song[0];
    } catch (error) {
      this.deleteUploadedFile(file);
      throw error;
    }

    if (!created) {
      this.deleteUploadedFile(file);
      throw new BadRequestException("Could not create song record.");
    }

    try {
      await this.audioJobsProducer.enqueueAudioProcessing({
        songId: created.id,
        blobUrl: streamUrl,
        requestedByUserId: userId
      });
    } catch (error) {
      this.logger.warn(`Upload ${created.id} is playable, but audio processing could not be queued: ${error instanceof Error ? error.message : String(error)}`);
    }

    response.status(201).json(created);
  }

  @Get("uploads/:fileName")
  @Header("Accept-Ranges", "bytes")
  streamUpload(@Param("fileName") fileName: string, @Req() request: Request, @Res() response: Response) {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "");

    if (!safeName) {
      throw new NotFoundException("Invalid file name.");
    }

    const filePath = join(UPLOADS_DIR, safeName);

    if (!existsSync(filePath)) {
      throw new NotFoundException("Uploaded file not found.");
    }

    const fileSize = statSync(filePath).size;
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
      response.setHeader("Content-Type", this.contentTypeForFile(safeName));
      stream.pipe(response);
    } else {
      response.setHeader("Content-Type", this.contentTypeForFile(safeName));
      response.setHeader("Content-Length", fileSize);
      createReadStream(filePath).pipe(response);
    }
  }

  private contentTypeForFile(fileName: string): string {
    const lower = fileName.toLowerCase();

    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".mp4")) return "audio/mp4";
    if (lower.endsWith(".aac")) return "audio/aac";
    if (lower.endsWith(".aif")) return "audio/aiff";
    if (lower.endsWith(".aiff")) return "audio/aiff";
    if (lower.endsWith(".m4b")) return "audio/mp4";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".flac")) return "audio/flac";
    if (lower.endsWith(".oga")) return "audio/ogg";
    if (lower.endsWith(".ogg")) return "audio/ogg";
    if (lower.endsWith(".opus")) return "audio/ogg";
    if (lower.endsWith(".weba")) return "audio/webm";
    if (lower.endsWith(".webm")) return "audio/webm";
    if (lower.endsWith(".wma")) return "audio/x-ms-wma";

    return "application/octet-stream";
  }

  private async readAudioMetadata(filePath: string): Promise<UploadedAudioMetadata> {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("music-metadata")>;
    const { parseFile } = await dynamicImport("music-metadata");
    const metadata = await parseFile(filePath, { duration: true });

    const formatMimeType = (metadata.format as { mimeType?: string }).mimeType;
    if (!metadata.format.container && !metadata.format.codec && !formatMimeType) {
      throw new Error("Unsupported audio file.");
    }

    const artists = metadata.common.artists?.map((artist) => this.cleanText(artist)).filter(Boolean) as string[] | undefined;
    const genres = metadata.common.genre?.map((genre) => this.cleanText(genre)).filter(Boolean) as string[] | undefined;

    return {
      duration: metadata.format.duration,
      title: this.cleanText(metadata.common.title),
      artistName: this.cleanText(metadata.common.artist) ?? (artists?.length ? artists.join(", ") : undefined),
      albumTitle: this.cleanText(metadata.common.album),
      genreNames: genres,
      lyrics: this.readLyrics(metadata.common.lyrics as Array<string | { text?: string }> | undefined)
    };
  }

  private readLyrics(lyrics?: Array<string | { text?: string }>): string | undefined {
    const text = lyrics
      ?.map((entry) => typeof entry === "string" ? entry : entry.text)
      .map((entry) => this.cleanText(entry))
      .filter(Boolean)
      .join("\n\n")
      .trim();

    return text || undefined;
  }

  private readFilenameMetadata(originalName: string): FilenameMetadata {
    const stem = this.stripFilenameNoise(this.fileStem(originalName));
    const albumMatch = stem.match(/\(([^)]*(?:ost|soundtrack|album|ep|single)[^)]*)\)/i);
    const albumTitle = this.cleanText(albumMatch?.[1]);
    const withoutAlbum = this.cleanText(stem.replace(/\([^)]*(?:ost|soundtrack|album|ep|single)[^)]*\)/gi, "")) ?? stem;
    const spacedSeparator = withoutAlbum.match(/^(.+?)\s[-–—]\s(.+)$/);

    if (spacedSeparator) {
      return {
        title: this.cleanTitle(spacedSeparator[1]),
        artistName: this.cleanArtist(spacedSeparator[2]),
        albumTitle
      };
    }

    const compactSeparator = withoutAlbum.match(/^(.+?)-([^-]+)$/);
    if (compactSeparator) {
      return {
        title: this.cleanTitle(compactSeparator[1]),
        artistName: this.cleanArtist(compactSeparator[2]),
        albumTitle
      };
    }

    return {
      title: this.cleanTitle(withoutAlbum),
      albumTitle
    };
  }

  private stripFilenameNoise(value: string): string {
    return value
      .replace(/[_]+/g, " ")
      .replace(/^\s*(?:\[\s*)?(?:lyrics?|official lyrics?|audio|official audio|mv|official mv)(?:\s*\])?\s*[-_:]*/i, "")
      .replace(/\s*-\s*\d{5,}\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanTitle(value?: string): string | undefined {
    return this.cleanText(value?.replace(/\s+/g, " "));
  }

  private cleanArtist(value?: string): string | undefined {
    const cleaned = this.cleanText(value?.replace(/\([^)]*\)/g, "").replace(/([a-z])([A-Z])/g, "$1 $2"));
    return cleaned;
  }

  private preferBodyValue(value: string | undefined, placeholder: string): string | undefined {
    if (!value || value.toLowerCase() === placeholder.toLowerCase()) {
      return undefined;
    }

    return value;
  }

  private fileStem(name: string): string {
    return name.replace(/\.[^/.]+$/, "").trim();
  }

  private cleanText(value?: string | null): string | undefined {
    const cleaned = value?.trim();
    return cleaned || undefined;
  }

  private deleteUploadedFile(file?: { path?: string }) {
    if (!file?.path || !existsSync(file.path)) {
      return;
    }

    try {
      unlinkSync(file.path);
    } catch {
      // Best-effort cleanup. The failed upload must not create a song record.
    }
  }
}
