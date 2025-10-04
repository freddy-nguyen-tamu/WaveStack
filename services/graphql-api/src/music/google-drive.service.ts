import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Song } from "./music.models";

type DriveShortcutDetails = {
  targetId?: string;
  targetMimeType?: string;
};

type DriveMediaMetadata = {
  durationMillis?: string;
  width?: number;
  height?: number;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  resourceKey?: string;
  webViewLink?: string;
  thumbnailLink?: string;
  properties?: Record<string, string>;
  appProperties?: Record<string, string>;
  imageMediaMetadata?: DriveMediaMetadata;
  videoMediaMetadata?: DriveMediaMetadata;
  shortcutDetails?: DriveShortcutDetails;
  parentFolderId?: string;
  sourceRootFolderId?: string;
};

type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
};

type ParsedSongName = {
  artistName: string;
  title: string;
};

export type DriveFolderDebug = {
  folderId: string;
  status: "ok" | "error";
  childCount: number;
  mp3Count: number;
  folderCount: number;
  shortcutCount: number;
  error?: string;
  sampleNames: string[];
};

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

const COVER_FILE_NAMES = new Set([
  "cover",
  "folder",
  "album",
  "artwork",
  "thumbnail",
  "thumb",
  "front"
]);

@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);
  private readonly imageById = new Map<string, DriveFile>();

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>("GOOGLE_DRIVE_API_KEY") ?? "";
  }

  get folderIds(): string[] {
    return Array.from(
      new Set(
        (this.config.get<string>("GOOGLE_DRIVE_FOLDER_IDS") ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );
  }

  get publicApiOriginForUrls(): string {
    return this.config.get<string>("API_PUBLIC_ORIGIN") ?? "http://localhost:3000";
  }

  private get publicApiOrigin(): string {
    return this.publicApiOriginForUrls;
  }

  async listSongs(): Promise<Song[]> {
    const files = await this.listAllDriveMediaFiles();
    const audioFiles = files.filter((file) => this.isAudioFile(file));
    const imageFiles = files.filter((file) => this.isImageFile(file));
    const textFiles = files.filter((file) => this.isTextOrLyricFile(file));

    this.imageById.clear();
    imageFiles.forEach((file) => this.imageById.set(file.id, file));

    const imageByFolder = this.groupImagesByFolder(imageFiles);
    const lyricSidecarMap = await this.buildLyricSidecarMap(audioFiles, textFiles);

    return audioFiles.map((file) => {
      const parsed = this.parseSongName(file.name);
      const properties = {
        ...(file.properties ?? {}),
        ...(file.appProperties ?? {})
      };

      const thumbnailUrl = `${this.publicApiOrigin}/drive/artwork/${file.id}`;

      const lyrics =
        this.cleanOptional(properties.lyrics) ??
        this.cleanOptional(properties.Lyrics) ??
        lyricSidecarMap.get(file.id) ??
        this.cleanOptional(properties.description) ??
        "";

      const durationSeconds = this.getDurationSeconds(file, properties);
      const sizeBytes = this.parseSizeBytes(file.size);

      return {
        id: `drive-${file.id}`,
        title: this.cleanOptional(properties.title) ?? parsed.title,
        artistName:
          this.cleanOptional(properties.artistName) ??
          this.cleanOptional(properties.artist) ??
          this.cleanOptional(properties.authorName) ??
          this.cleanOptional(properties.author) ??
          parsed.artistName,
        albumTitle:
          this.cleanOptional(properties.albumTitle) ??
          this.cleanOptional(properties.album) ??
          (file.sourceRootFolderId ? `Drive Folder ${file.sourceRootFolderId}` : "Public Drive Folder"),
        durationSeconds,
        streamUrl: `${this.publicApiOrigin}/drive/stream/${file.id}`,
        genreNames: this.parseGenres(properties.genreNames ?? properties.genres),
        thumbnailUrl,
        lyrics,
        webViewLink: file.webViewLink,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        sizeBytes,
        sourceRootFolderId: file.sourceRootFolderId
      };
    });
  }

  async listAllDriveMediaFiles(): Promise<DriveFile[]> {
    if (!this.apiKey || !this.folderIds.length) {
      this.logger.warn("Google Drive is not configured. Returning no Drive songs.");
      return [];
    }

    const allFiles: DriveFile[] = [];

    for (const folderId of this.folderIds) {
      const visitedFolders = new Set<string>();

      try {
        const files = await this.listMediaFilesInFolderRecursive({
          rootFolderId: folderId,
          folderId,
          visitedFolders
        });

        this.logger.log(
          `Google Drive root ${folderId}: loaded ${files.length} media file(s).`
        );

        allFiles.push(...files);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Google Drive root ${folderId}: failed: ${message}`);
      }
    }

    const unique = Array.from(
      new Map(allFiles.map((file) => [file.id, file])).values()
    ).sort((a, b) => a.name.localeCompare(b.name));

    this.logger.log(
      `Google Drive total: ${unique.length} unique media file(s) from ${this.folderIds.length} root folder(s).`
    );

    return unique;
  }

  // Keep this old method name in case controllers/debug code still call it.
  async listAllDriveMp3Files(): Promise<DriveFile[]> {
    return (await this.listAllDriveMediaFiles()).filter((file) => this.isAudioFile(file));
  }

  async debugFolders(): Promise<DriveFolderDebug[]> {
    const results: DriveFolderDebug[] = [];

    for (const folderId of this.folderIds) {
      try {
        const children = await this.listChildren(folderId);
        const mp3Files = children.filter((file) => this.isAudioFile(file));
        const folders = children.filter((file) => file.mimeType === GOOGLE_FOLDER_MIME);
        const shortcuts = children.filter((file) => file.mimeType === GOOGLE_SHORTCUT_MIME);

        results.push({
          folderId,
          status: "ok",
          childCount: children.length,
          mp3Count: mp3Files.length,
          folderCount: folders.length,
          shortcutCount: shortcuts.length,
          sampleNames: children.slice(0, 20).map((file) => `${file.name} | ${file.mimeType ?? "unknown"}`)
        });
      } catch (error) {
        results.push({
          folderId,
          status: "error",
          childCount: 0,
          mp3Count: 0,
          folderCount: 0,
          shortcutCount: 0,
          error: error instanceof Error ? error.message : String(error),
          sampleNames: []
        });
      }
    }

    return results;
  }

  async getImageMediaUrl(fileId: string): Promise<string | undefined> {
    const cached = this.imageById.get(fileId);

    if (cached && this.isImageFile(cached)) {
      return this.getMediaUrl(fileId);
    }

    const file = await this.getFile(fileId);

    if (!file || !this.isImageFile(file)) {
      return undefined;
    }

    this.imageById.set(fileId, file);
    return this.getMediaUrl(fileId);
  }

  getMediaUrl(fileId: string): string {
    const params = new URLSearchParams({
      key: this.apiKey,
      alt: "media"
    });

    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;
  }

  private async listMediaFilesInFolderRecursive(input: {
    rootFolderId: string;
    folderId: string;
    visitedFolders: Set<string>;
  }): Promise<DriveFile[]> {
    if (input.visitedFolders.has(input.folderId)) {
      return [];
    }

    input.visitedFolders.add(input.folderId);

    const children = await this.listChildren(input.folderId);
    const mediaFiles: DriveFile[] = [];

    for (const child of children) {
      if (child.mimeType === GOOGLE_SHORTCUT_MIME && child.shortcutDetails?.targetId) {
        const target = await this.getFile(child.shortcutDetails.targetId);

        if (!target) {
          continue;
        }

        if (target.mimeType === GOOGLE_FOLDER_MIME) {
          mediaFiles.push(
            ...(await this.listMediaFilesInFolderRecursive({
              rootFolderId: input.rootFolderId,
              folderId: target.id,
              visitedFolders: input.visitedFolders
            }))
          );
          continue;
        }

        if (this.isMediaFile(target)) {
          mediaFiles.push({
            ...target,
            parentFolderId: input.folderId,
            sourceRootFolderId: input.rootFolderId
          });
        }

        continue;
      }

      if (child.mimeType === GOOGLE_FOLDER_MIME) {
        mediaFiles.push(
          ...(await this.listMediaFilesInFolderRecursive({
            rootFolderId: input.rootFolderId,
            folderId: child.id,
            visitedFolders: input.visitedFolders
          }))
        );
        continue;
      }

      if (this.isMediaFile(child)) {
        mediaFiles.push({
          ...child,
          parentFolderId: input.folderId,
          sourceRootFolderId: input.rootFolderId
        });
      }
    }

    return mediaFiles;
  }

  private async listChildren(folderId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        key: this.apiKey,
        q: `'${folderId}' in parents and trashed = false`,
        fields:
          "nextPageToken,files(id,name,mimeType,size,modifiedTime,resourceKey,webViewLink,thumbnailLink,properties,appProperties,imageMediaMetadata(width,height),videoMediaMetadata(durationMillis),shortcutDetails(targetId,targetMimeType))",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
      });

      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);

      if (!response.ok) {
        throw new Error(`Drive list failed with ${response.status}: ${await response.text()}`);
      }

      const payload = (await response.json()) as DriveListResponse;
      files.push(...(payload.files ?? []));
      pageToken = payload.nextPageToken;
    } while (pageToken);

    return files;
  }

  private async getFile(fileId: string): Promise<DriveFile | undefined> {
    const params = new URLSearchParams({
      key: this.apiKey,
      fields:
        "id,name,mimeType,size,modifiedTime,resourceKey,webViewLink,thumbnailLink,properties,appProperties,imageMediaMetadata(width,height),videoMediaMetadata(durationMillis),shortcutDetails(targetId,targetMimeType)",
      supportsAllDrives: "true"
    });

    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`);

    if (!response.ok) {
      this.logger.warn(`Drive get file ${fileId} failed with ${response.status}.`);
      return undefined;
    }

    return (await response.json()) as DriveFile;
  }

  private isMediaFile(file: DriveFile): boolean {
    return this.isAudioFile(file) || this.isImageFile(file);
  }

  private isAudioFile(file: DriveFile): boolean {
    const name = (file.name ?? "").toLowerCase();
    const mimeType = (file.mimeType ?? "").toLowerCase();

    if (mimeType === GOOGLE_FOLDER_MIME || mimeType === GOOGLE_SHORTCUT_MIME) {
      return false;
    }

    return (
      name.endsWith(".mp3") ||
      name.endsWith(".m4a") ||
      name.endsWith(".flac") ||
      name.endsWith(".aac") ||
      name.endsWith(".ogg") ||
      name.endsWith(".opus") ||
      name.endsWith(".wav") ||
      mimeType === "audio/mpeg" ||
      mimeType === "audio/mp3" ||
      mimeType === "audio/x-mpeg" ||
      mimeType === "audio/mpeg3" ||
      mimeType === "audio/x-mpeg-3" ||
      mimeType === "audio/mp4" ||
      mimeType === "audio/m4a" ||
      mimeType === "audio/x-m4a" ||
      mimeType === "audio/aac" ||
      mimeType === "audio/flac" ||
      mimeType === "audio/x-flac" ||
      mimeType === "audio/ogg" ||
      mimeType === "audio/opus" ||
      mimeType === "audio/wav" ||
      mimeType === "audio/x-wav"
    );
  }

  private isTextOrLyricFile(file: DriveFile): boolean {
    const name = (file.name ?? "").toLowerCase();
    const mimeType = (file.mimeType ?? "").toLowerCase();

    return (
      name.endsWith(".lrc") ||
      name.endsWith(".txt") ||
      mimeType === "text/plain" ||
      mimeType === "text/lrc"
    );
  }

  private async buildLyricSidecarMap(
    audioFiles: DriveFile[],
    textFiles: DriveFile[]
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    for (const audioFile of audioFiles) {
      const audioBase = this.cleanFileBaseName(audioFile.name).toLowerCase();
      const audioFolder = audioFile.parentFolderId ?? audioFile.sourceRootFolderId ?? "root";

      const matching = textFiles.filter((textFile) => {
        const textBase = this.cleanFileBaseName(textFile.name).toLowerCase();
        const textFolder = textFile.parentFolderId ?? textFile.sourceRootFolderId ?? "root";
        return textBase === audioBase && textFolder === audioFolder;
      });

      if (matching.length > 0) {
        const content = await this.fetchTextContent(matching[0].id);
        if (content) {
          map.set(audioFile.id, content);
        }
      }
    }

    return map;
  }

  private async fetchTextContent(fileId: string): Promise<string | undefined> {
    const params = new URLSearchParams({
      key: this.apiKey,
      alt: "media"
    });

    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        this.logger.warn(`Drive text file ${fileId} fetch failed with ${response.status}.`);
        return undefined;
      }

      const text = await response.text();
      return text.trim() || undefined;
    } catch (error) {
      this.logger.warn(`Drive text file ${fileId} fetch error: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private isImageFile(file: DriveFile): boolean {
    const name = (file.name ?? "").toLowerCase();
    const mimeType = (file.mimeType ?? "").toLowerCase();

    if (mimeType === GOOGLE_FOLDER_MIME || mimeType === GOOGLE_SHORTCUT_MIME) {
      return false;
    }

    return (
      mimeType.startsWith("image/") ||
      name.endsWith(".jpg") ||
      name.endsWith(".jpeg") ||
      name.endsWith(".png") ||
      name.endsWith(".webp") ||
      name.endsWith(".gif") ||
      name.endsWith(".avif")
    );
  }

  private groupImagesByFolder(imageFiles: DriveFile[]): Map<string, DriveFile[]> {
    const imagesByFolder = new Map<string, DriveFile[]>();

    for (const image of imageFiles) {
      const folderId = image.parentFolderId ?? image.sourceRootFolderId ?? "root";
      const existing = imagesByFolder.get(folderId) ?? [];
      existing.push(image);
      imagesByFolder.set(folderId, existing);
    }

    for (const [folderId, images] of imagesByFolder.entries()) {
      imagesByFolder.set(
        folderId,
        images.sort((a, b) => this.coverRank(a) - this.coverRank(b) || a.name.localeCompare(b.name))
      );
    }

    return imagesByFolder;
  }

  private findBestCoverImage(audioFile: DriveFile, imagesByFolder: Map<string, DriveFile[]>): DriveFile | undefined {
    const folderId = audioFile.parentFolderId ?? audioFile.sourceRootFolderId ?? "root";
    const images = imagesByFolder.get(folderId) ?? [];

    if (!images.length) {
      return undefined;
    }

    const audioBase = this.cleanFileBaseName(audioFile.name).toLowerCase();

    const exactMatch = images.find((image) => this.cleanFileBaseName(image.name).toLowerCase() === audioBase);
    if (exactMatch) {
      return exactMatch;
    }

    const coverNameMatch = images.find((image) => COVER_FILE_NAMES.has(this.cleanFileBaseName(image.name).toLowerCase()));
    if (coverNameMatch) {
      return coverNameMatch;
    }

    return images[0];
  }

  private coverRank(file: DriveFile): number {
    const base = this.cleanFileBaseName(file.name).toLowerCase();

    if (base === "cover") return 0;
    if (base === "folder") return 1;
    if (base === "album") return 2;
    if (base === "artwork") return 3;
    if (base === "thumbnail" || base === "thumb") return 4;

    return 10;
  }

  private getDurationSeconds(file: DriveFile, properties: Record<string, string>): number {
    const explicitSeconds = this.parsePositiveNumber(
      properties.durationSeconds ??
        properties.duration_seconds ??
        properties.duration ??
        properties.lengthSeconds ??
        properties.length
    );

    if (explicitSeconds) {
      return Math.round(explicitSeconds);
    }

    const explicitMillis = this.parsePositiveNumber(
      properties.durationMillis ??
        properties.duration_ms ??
        file.videoMediaMetadata?.durationMillis
    );

    if (explicitMillis) {
      return Math.round(explicitMillis / 1000);
    }

    const sizeBytes = this.parseSizeBytes(file.size);

    if (sizeBytes) {
      // Approximate audio length from file size so dashboard layout still has real
      // variety when Drive does not expose audio metadata. 160 kbps is a common
      // MP3 bitrate: 160,000 bits/sec = 20,000 bytes/sec.
      return Math.max(30, Math.round(sizeBytes / 20000));
    }

    return 0;
  }

  private parseSizeBytes(value: string | undefined): number | undefined {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private parsePositiveNumber(value: string | number | undefined): number | undefined {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private parseSongName(fileName: string): ParsedSongName {
    const cleaned = this.cleanFileBaseName(fileName);

    const parts = cleaned
      .split(/\s+(?:-|–|—)\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      return {
        artistName: this.cleanDisplayText(parts[0]) || "Unknown Artist",
        title: this.cleanDisplayText(parts.slice(1).join(" - ")) || cleaned
      };
    }

    return {
      artistName: "Unknown Artist",
      title: this.cleanDisplayText(cleaned) || "Untitled Track"
    };
  }

  private parseGenres(value: string | undefined): string[] {
    const parsed = this.cleanOptional(value)
      ?.split(/[,\n|]/)
      .map((item) => item.trim())
      .filter(Boolean);

    return parsed?.length ? parsed : ["audio", "google-drive"];
  }

  private cleanFileBaseName(name: string): string {
    return name
      .replace(/\.[^.]+$/, "")
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanDisplayText(value: string): string {
    return value
      .replace(/\[[A-Za-z0-9_-]{8,}\]$/g, "")
      .replace(/\((official\s*)?(audio|video|lyrics?|visualizer|HD|HQ)\)$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanOptional(value: string | undefined): string | undefined {
    const cleaned = String(value ?? "").trim();
    return cleaned ? cleaned : undefined;
  }
}
