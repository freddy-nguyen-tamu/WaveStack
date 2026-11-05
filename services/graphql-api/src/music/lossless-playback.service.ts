import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { Request, Response } from "express";
import { parseFile } from "music-metadata";
import { DriveDownloadService } from "./drive-download.service";

const PROBE_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Chrome/Firefox cannot decode Apple Lossless (ALAC) inside M4A reliably.
 * Transcode ONLY ALAC to FLAC: both codecs are lossless, so PCM audio is
 * unchanged. AAC-M4A, MP3, FLAC, etc. continue down the original stream path.
 * Finished FLAC files are cached to support normal HTTP seeking/range requests.
 */
@Injectable()
export class LosslessPlaybackService {
  private readonly logger = new Logger(LosslessPlaybackService.name);
  private readonly pending = new Map<string, Promise<string>>();
  private readonly cacheDir = join(
    dirname(process.env.DRIVE_TRACK_SYNC_THUMBNAIL_DIR ?? "/app/.cache/thumbnails"),
    "lossless-playback"
  );

  constructor(private readonly driveDownloadService: DriveDownloadService) {}

  async prepareDrive(fileId: string, modifiedTime?: string): Promise<string | null> {
    const key = this.key(`drive:${fileId}:${modifiedTime ?? ""}`);
    const cached = join(this.cacheDir, `${key}.flac`);
    if (await this.isCached(cached)) return cached;

    // A small probe makes AAC-in-M4A take the existing direct-stream path.
    // Check both ends: some MP4 files place the sample description at the end.
    const prefix = await this.driveDownloadService.fetchMedia(
      fileId, `bytes=0-${PROBE_BYTES - 1}`, AbortSignal.timeout(15000)
    );
    if (!prefix.ok) {
      await prefix.body?.cancel();
      throw new Error(`Cannot inspect M4A format (HTTP ${prefix.status}).`);
    }
    const first = Buffer.from(await prefix.arrayBuffer());
    let alac = this.hasAlacSampleEntry(first);
    if (!alac && prefix.status === 206) {
      const tail = await this.driveDownloadService.fetchMedia(
        fileId, `bytes=-${PROBE_BYTES}`, AbortSignal.timeout(15000)
      );
      if (tail.ok) alac = this.hasAlacSampleEntry(Buffer.from(await tail.arrayBuffer()));
      else await tail.body?.cancel();
    }
    if (!alac) return null;

    return this.getOrCreate(key, async (source) => {
      const response = await this.driveDownloadService.fetchMedia(fileId, undefined, AbortSignal.timeout(90000));
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Cannot download ALAC track (HTTP ${response.status}).`);
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_SOURCE_BYTES) {
        await response.body.cancel();
        throw new Error("ALAC track exceeds maximum supported source size.");
      }
      let downloaded = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloaded += chunk.length;
          callback(downloaded > MAX_SOURCE_BYTES ? new Error("ALAC track is too large.") : null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body as any), cap, createWriteStream(source));
    });
  }

  async prepareUpload(filePath: string): Promise<string | null> {
    if (!/\.m4a$/i.test(filePath)) return null;
    const details = await stat(filePath);
    const key = this.key(`upload:${filePath}:${details.mtimeMs}:${details.size}`);
    const cached = join(this.cacheDir, `${key}.flac`);
    if (await this.isCached(cached)) return cached;
    const metadata = await parseFile(filePath, { duration: false, skipCovers: true });
    const codec = (metadata.format.codec ?? "").toLowerCase();
    if (!codec.includes("alac") && !codec.includes("apple lossless")) return null;
    if (details.size > MAX_SOURCE_BYTES) throw new Error("ALAC track is too large.");
    return this.getOrCreate(key, async (source) => {
      await pipeline(createReadStream(filePath), createWriteStream(source));
    });
  }

  private hasAlacSampleEntry(buffer: Buffer): boolean {
    // "alac" must be an MP4 audio sample-entry fourcc. Don't accidentally
    // treat the word appearing inside an AAC track's lyrics as an ALAC codec.
    const fourcc = Buffer.from("alac", "ascii");
    let position = 0;
    while ((position = buffer.indexOf(fourcc, position)) >= 0) {
      if (position >= 4) {
        const boxSize = buffer.readUInt32BE(position - 4);
        if (boxSize >= 36 && boxSize <= MAX_SOURCE_BYTES) return true;
      }
      position += 4;
    }
    return false;
  }

  private key(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private async isCached(path: string): Promise<boolean> {
    try {
      const info = await stat(path);
      if (info.size < 42) return false;
      // Updating atime helps the bounded cache retain recently played songs.
      void utimes(path, new Date(), new Date()).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  private async getOrCreate(key: string, fetchSource: (source: string) => Promise<void>): Promise<string> {
    const output = join(this.cacheDir, `${key}.flac`);
    if (await this.isCached(output)) return output;
    const existing = this.pending.get(key);
    if (existing) return existing;

    const task = (async () => {
      await mkdir(this.cacheDir, { recursive: true });
      if (await this.isCached(output)) return output;
      const nonce = randomUUID();
      const input = join(this.cacheDir, `${key}-${nonce}.m4a.tmp`);
      const tempOutput = join(this.cacheDir, `${key}-${nonce}.flac.tmp`);
      try {
        await fetchSource(input);
        await this.convertToFlac(input, tempOutput);
        if ((await stat(tempOutput)).size < 42) throw new Error("Lossless conversion yielded no audio.");
        await rename(tempOutput, output);
        void this.pruneCache().catch(error => this.logger.debug(`Cache pruning failed: ${String(error)}`));
        return output;
      } finally {
        await Promise.all([unlink(input).catch(() => undefined), unlink(tempOutput).catch(() => undefined)]);
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private convertToFlac(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // No lossy encoder, downsampling, volume adjustment or channel remixing.
      const child = spawn("ffmpeg", [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-i", input, "-map", "0:a:0", "-vn", "-map_metadata", "-1",
        "-c:a", "flac", "-compression_level", "5", "-f", "flac", output
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let diagnostic = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString("utf8")).slice(-2048);
      });
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`Lossless FLAC conversion failed (${code}): ${diagnostic.trim()}`));
      });
    });
  }

  /** Serve the cached lossless copy with accurate byte ranges for seeking. */
  async serveFlac(filePath: string, request: Request, response: Response): Promise<void> {
    const size = (await stat(filePath)).size;
    response.setHeader("Content-Type", "audio/flac");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

    const range = request.headers.range;
    let start = 0;
    let end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match || (!match[1] && !match[2])) {
        response.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          response.status(416).setHeader("Content-Range", `bytes */${size}`).end();
          return;
        }
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        response.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      end = Math.min(end, size - 1);
      response.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    } else {
      response.status(200);
    }
    response.setHeader("Content-Length", String(end - start + 1));
    createReadStream(filePath, { start, end }).pipe(response);
  }

  private async pruneCache(): Promise<void> {
    if (!existsSync(this.cacheDir)) return;
    const entries = await Promise.all((await readdir(this.cacheDir))
      .filter(name => name.endsWith(".flac"))
      .map(async name => {
        const file = join(this.cacheDir, name);
        try { return { file, stats: await stat(file) }; } catch { return null; }
      }));
    const ordered = entries.filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((a, b) => a.stats.atimeMs - b.stats.atimeMs);
    let total = ordered.reduce((sum, entry) => sum + entry.stats.size, 0);
    for (const entry of ordered) {
      if (Date.now() - entry.stats.atimeMs < CACHE_AGE_MS && total <= MAX_CACHE_BYTES) break;
      try { await unlink(entry.file); total -= entry.stats.size; } catch { /* May be in use. */ }
    }
  }
}
