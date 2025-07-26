import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Song } from "./music.models";

type DriveShortcutDetails = {
  targetId?: string;
  targetMimeType?: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  resourceKey?: string;
  webViewLink?: string;
  shortcutDetails?: DriveShortcutDetails;
  parentFolderId?: string;
  sourceRootFolderId?: string;
};

type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
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

  private get folderIds(): string[] {
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

    return files.map((file) => ({
      id: `drive-${file.id}`,
      title: this.cleanTitle(file.name),
      artistName: "Google Drive Library",
      albumTitle: file.sourceRootFolderId
        ? `Drive Folder ${file.sourceRootFolderId}`
        : "Public Drive Folder",
      durationSeconds: 0,
      streamUrl: `${this.publicApiOrigin}/drive/stream/${file.id}`,
      genreNames: ["mp3", "google-drive"]
    }));
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

        this.logger.log(
          `Google Drive root ${folderId}: loaded ${files.length} MP3 file(s).`
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
      `Google Drive total: ${unique.length} unique MP3 file(s) from ${this.folderIds.length} root folder(s).`
    );

    return unique;
  }

  async debugFolders(): Promise<DriveFolderDebug[]> {
    const results: DriveFolderDebug[] = [];

    for (const folderId of this.folderIds) {
      try {
        const children = await this.listChildren(folderId);
        const mp3Files = children.filter((file) => this.isMp3File(file));
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

  private async listMp3FilesInFolderRecursive(input: {
    rootFolderId: string;
    folderId: string;
    visitedFolders: Set<string>;
  }): Promise<DriveFile[]> {
    const { rootFolderId, folderId, visitedFolders } = input;

    if (visitedFolders.has(folderId)) {
      return [];
    }

    visitedFolders.add(folderId);

    const children = await this.listChildren(folderId);
    const mp3Files: DriveFile[] = [];

    for (const child of children) {
      const effectiveId = child.shortcutDetails?.targetId ?? child.id;
      const effectiveMimeType = child.shortcutDetails?.targetMimeType ?? child.mimeType;

      if (effectiveMimeType === GOOGLE_FOLDER_MIME || child.mimeType === GOOGLE_FOLDER_MIME) {
        const nestedFiles = await this.listMp3FilesInFolderRecursive({
          rootFolderId,
          folderId: effectiveId,
          visitedFolders
        });

        mp3Files.push(...nestedFiles);
        continue;
      }

      if (child.mimeType === GOOGLE_SHORTCUT_MIME && child.shortcutDetails?.targetId) {
        const resolvedShortcut: DriveFile = {
          ...child,
          id: effectiveId,
          mimeType: effectiveMimeType,
          parentFolderId: folderId,
          sourceRootFolderId: rootFolderId
        };

        if (this.isMp3File(resolvedShortcut)) {
          mp3Files.push(resolvedShortcut);
        }

        continue;
      }

      if (this.isMp3File(child)) {
        mp3Files.push({
          ...child,
          parentFolderId: folderId,
          sourceRootFolderId: rootFolderId
        });
      }
    }

    return mp3Files;
  }

  private async listChildren(folderId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        key: this.apiKey,
        q: `'${folderId}' in parents and trashed = false`,
        fields: [
          "nextPageToken",
          "files(" +
            [
              "id",
              "name",
              "mimeType",
              "size",
              "modifiedTime",
              "resourceKey",
              "webViewLink",
              "shortcutDetails(targetId,targetMimeType)"
            ].join(",") +
            ")"
        ].join(","),
        pageSize: "1000",
        orderBy: "folder,name_natural",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
      });

      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`folder ${folderId} list failed: ${response.status} ${body}`);
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

  private isMp3File(file: DriveFile): boolean {
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

  private cleanTitle(name: string): string {
    return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  }
}
