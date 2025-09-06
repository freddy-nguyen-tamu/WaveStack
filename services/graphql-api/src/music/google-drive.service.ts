import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Song } from "./music.models";

type DriveShortcutDetails = {
  targetId?: string;
  targetMimeType?: string;
};

export type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  resourceKey?: string;
  webViewLink?: string;
  thumbnailLink?: string;
  description?: string;
  properties?: Record<string, string>;
  appProperties?: Record<string, string>;
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

@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);

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

  private get publicApiOrigin(): string {
    return this.config.get<string>("API_PUBLIC_ORIGIN") ?? "http://localhost:3000";
  }

  async listSongs(): Promise<Song[]> {
    const files = await this.listAllDriveMp3Files();

    return files.map((file) => {
      const parsed = this.parseSongName(file.name);
      const properties = {
        ...(file.properties ?? {}),
        ...(file.appProperties ?? {})
      };

      const thumbnailUrl =
        this.cleanOptional(properties.thumbnailUrl) ??
        this.cleanOptional(properties.thumbnail) ??
        this.cleanOptional(properties.coverUrl) ??
        this.cleanOptional(properties.cover) ??
        this.cleanOptional(file.thumbnailLink);

      const lyrics =
        this.cleanOptional(properties.lyrics) ??
        this.cleanOptional(properties.Lyrics) ??
        this.cleanOptional(file.description) ??
        "";

      const durationSeconds = Number(properties.durationSeconds ?? properties.duration ?? 0);

      return {
        id: `drive-${file.id}`,
        title: this.cleanOptional(properties.title) ?? parsed.title,
        artistName:
          this.cleanOptional(properties.artistName) ??
          this.cleanOptional(properties.artist) ??
          this.cleanOptional(properties.authorName) ??
          this.cleanOptional(properties.author) ??
          parsed.artistName,
        albumTitle: this.cleanOptional(properties.albumTitle)
          ?? this.cleanOptional(properties.album)
          ?? (file.sourceRootFolderId
            ? `Drive Folder ${file.sourceRootFolderId}`
            : "Public Drive Folder"),
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
        streamUrl: `${this.publicApiOrigin}/drive/stream/${file.id}`,
        genreNames: this.parseGenres(properties.genreNames ?? properties.genres),
        thumbnailUrl,
        lyrics,
        webViewLink: file.webViewLink,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        sizeBytes: file.size ? Number(file.size) : undefined,
        sourceRootFolderId: file.sourceRootFolderId
      };
    });
  }

  async listAllDriveMp3Files(): Promise<DriveFile[]> {
    if (!this.apiKey || !this.folderIds.length) {
      this.logger.warn("Google Drive is not configured. Returning no Drive songs.");
      return [];
    }

    const allFiles: DriveFile[] = [];

    for (const folderId of this.folderIds) {
      const visitedFolders = new Set<string>();

      try {
        const files = await this.listMp3FilesInFolderRecursive({
          rootFolderId: folderId,
          folderId,
          visitedFolders
        });

        this.logger.log(`Google Drive root ${folderId}: loaded ${files.length} audio file(s).`);
        allFiles.push(...files);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Google Drive root ${folderId}: failed: ${message}`);
      }
    }

    return allFiles;
  }

  async getFolderDebug(folderId: string): Promise<DriveFolderDebug> {
    try {
      const children = await this.listFolderChildren(folderId);
      const mp3Files = children.filter((file) => this.isAudioFile(file));
      const folders = children.filter((file) => file.mimeType === GOOGLE_FOLDER_MIME);
      const shortcuts = children.filter((file) => file.mimeType === GOOGLE_SHORTCUT_MIME);

      return {
        folderId,
        status: "ok",
        childCount: children.length,
        mp3Count: mp3Files.length,
        folderCount: folders.length,
        shortcutCount: shortcuts.length,
        sampleNames: children.slice(0, 20).map((file) => file.name)
      };
    } catch (error) {
      return {
        folderId,
        status: "error",
        childCount: 0,
        mp3Count: 0,
        folderCount: 0,
        shortcutCount: 0,
        error: error instanceof Error ? error.message : String(error),
        sampleNames: []
      };
    }
  }

  private async listMp3FilesInFolderRecursive({
    rootFolderId,
    folderId,
    visitedFolders
  }: {
    rootFolderId: string;
    folderId: string;
    visitedFolders: Set<string>;
  }): Promise<DriveFile[]> {
    if (visitedFolders.has(folderId)) {
      return [];
    }

    visitedFolders.add(folderId);

    const children = await this.listFolderChildren(folderId);
    const audioFiles: DriveFile[] = [];

    for (const child of children) {
      if (this.isAudioFile(child)) {
        audioFiles.push({
          ...child,
          sourceRootFolderId: rootFolderId,
          parentFolderId: folderId
        });
        continue;
      }

      const targetFolderId =
        child.mimeType === GOOGLE_SHORTCUT_MIME &&
        child.shortcutDetails?.targetMimeType === GOOGLE_FOLDER_MIME
          ? child.shortcutDetails.targetId
          : undefined;

      if (child.mimeType === GOOGLE_FOLDER_MIME || targetFolderId) {
        const nestedFolderId = targetFolderId ?? child.id;
        const nested = await this.listMp3FilesInFolderRecursive({
          rootFolderId,
          folderId: nestedFolderId,
          visitedFolders
        });
        audioFiles.push(...nested);
      }
    }

    return audioFiles;
  }

  private async listFolderChildren(folderId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        key: this.apiKey,
        q: `'${folderId}' in parents and trashed = false`,
        fields:
          "nextPageToken,files(id,name,mimeType,size,modifiedTime,resourceKey,webViewLink,thumbnailLink,description,properties,appProperties,shortcutDetails)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
      });

      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);

      if (!response.ok) {
        throw new Error(`Google Drive list failed with ${response.status}`);
      }

      const payload = (await response.json()) as DriveListResponse;
      files.push(...(payload.files ?? []));
      pageToken = payload.nextPageToken;
    } while (pageToken);

    return files;
  }

  getMediaUrl(fileId: string): string {
    const params = new URLSearchParams({
      key: this.apiKey,
      alt: "media"
    });

    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;
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
