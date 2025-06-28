import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Song } from "./music.models";

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
};

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

    const files = (
      await Promise.all(this.folderIds.map((folderId) => this.listMp3FilesInFolder(folderId)))
    ).flat();

    return files.map((file) => ({
      id: `drive-${file.id}`,
      title: this.cleanTitle(file.name),
      artistName: "Google Drive Library",
      albumTitle: "Public Drive Folder",
      durationSeconds: 0,
      streamUrl: `${this.publicApiOrigin}/drive/stream/${file.id}`,
      genreNames: ["mp3", "google-drive"]
    }));
  }

  private async listMp3FilesInFolder(folderId: string): Promise<DriveFile[]> {
    const query = [
      `'${folderId}' in parents`,
      "trashed = false",
      "mimeType = 'audio/mpeg'"
    ].join(" and ");

    const params = new URLSearchParams({
      key: this.apiKey,
      q: query,
      fields: "files(id,name,mimeType,size,modifiedTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true"
    });

    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Drive list failed for folder ${folderId}: ${response.status} ${body}`);
    }

    const payload = (await response.json()) as { files?: DriveFile[] };
    return payload.files ?? [];
  }

  getMediaUrl(fileId: string): string {
    const params = new URLSearchParams({
      key: this.apiKey,
      alt: "media"
    });

    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;
  }

  private cleanTitle(name: string): string {
    return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  }
}
