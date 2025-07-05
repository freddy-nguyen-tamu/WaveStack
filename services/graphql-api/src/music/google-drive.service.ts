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
  shortcutDetails?: DriveShortcutDetails;
  parentFolderId?: string;
};

type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
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
    return (this.config.get<string>("GOOGLE_DRIVE_FOLDER_IDS") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private get publicApiOrigin(): string {
    return this.config.get<string>("API_PUBLIC_ORIGIN") ?? "http://localhost:3000";
  }

  async listSongs(): Promise<Song[]> {
    if (!this.apiKey || !this.folderIds.length) {
      this.logger.warn("Google Drive is not configured. Returning no Drive songs.");
      return [];
    }

    const allFiles: DriveFile[] = [];

    for (const folderId of this.folderIds) {
      try {
        const files = await this.listMp3FilesInFolderRecursive(folderId, new Set<string>());
        this.logger.log(`Loaded ${files.length} MP3 file(s) from Google Drive folder ${folderId}`);
        allFiles.push(...files);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Skipping Google Drive folder ${folderId}: ${message}`);
      }
    }

    const uniqueFiles = Array.from(
      new Map(allFiles.map((file) => [file.id, file])).values()
    ).sort((a, b) => a.name.localeCompare(b.name));

    return uniqueFiles.map((file) => ({
      id: `drive-${file.id}`,
      title: this.cleanTitle(file.name),
      artistName: "Google Drive Library",
      albumTitle: file.parentFolderId ? `Drive Folder ${file.parentFolderId}` : "Public Drive Folder",
      durationSeconds: 0,
      streamUrl: `${this.publicApiOrigin}/drive/stream/${file.id}`,
      genreNames: ["mp3", "google-drive"]
    }));
  }

  private async listMp3FilesInFolderRecursive(
    folderId: string,
    visitedFolders: Set<string>
  ): Promise<DriveFile[]> {
    if (visitedFolders.has(folderId)) {
      return [];
    }

    visitedFolders.add(folderId);

    const children = await this.listChildren(folderId);
    const mp3Files: DriveFile[] = [];

    for (const child of children) {
      const effectiveId = child.shortcutDetails?.targetId ?? child.id;
      const effectiveMimeType = child.shortcutDetails?.targetMimeType ?? child.mimeType;

      if (
        effectiveMimeType === GOOGLE_FOLDER_MIME ||
        child.mimeType === GOOGLE_FOLDER_MIME
      ) {
        const nestedFiles = await this.listMp3FilesInFolderRecursive(effectiveId, visitedFolders);
        mp3Files.push(...nestedFiles);
        continue;
      }

      if (child.mimeType === GOOGLE_SHORTCUT_MIME && child.shortcutDetails?.targetId) {
        if (this.isMp3File({ ...child, id: effectiveId, mimeType: effectiveMimeType })) {
          mp3Files.push({
            ...child,
            id: effectiveId,
            mimeType: effectiveMimeType,
            parentFolderId: folderId
          });
        }

        continue;
      }

      if (this.isMp3File(child)) {
        mp3Files.push({
          ...child,
          parentFolderId: folderId
        });
      }
    }

    return mp3Files;
  }

  private async listChildren(folderId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const query = [
        `'${folderId}' in parents`,
        "trashed = false"
      ].join(" and ");

      const params = new URLSearchParams({
        key: this.apiKey,
        q: query,
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails(targetId,targetMimeType))",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
      });

      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Google Drive list failed for folder ${folderId}: ${response.status} ${body}`);
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
    const name = file.name.toLowerCase();
    const mimeType = (file.mimeType ?? "").toLowerCase();

    return (
      name.endsWith(".mp3") ||
      mimeType === "audio/mpeg" ||
      mimeType === "audio/mp3" ||
      mimeType === "audio/x-mpeg" ||
      mimeType === "application/octet-stream"
    );
  }

  private cleanTitle(name: string): string {
    return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  }
}
