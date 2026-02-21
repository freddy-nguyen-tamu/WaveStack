import { Injectable, Logger } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

export type ArchivedListeningEvent = {
  id?: string;
  userId: string;
  userEmail?: string;
  displayName?: string;
  songId: string;
  artistName: string;
  title: string;
  durationSeconds: number;
  completedPlayRatio: number;
  startedAt: string;
};

export type ListeningArchiveFilePayload = {
  userId: string;
  userEmail?: string;
  displayName?: string;
  archiveDate: string;
  events: ArchivedListeningEvent[];
};

export type ListeningRollupFilePayload = {
  userId: string;
  userEmail?: string;
  displayName?: string;
  monthStart: string;
  rows: Array<{
    songId: string;
    artistName: string;
    title: string;
    playCount: number;
    totalDurationSeconds: number;
  }>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any

@Injectable()
export class DrivePrivateExportService {
  private readonly logger = new Logger(DrivePrivateExportService.name);
  private driveInstance: drive_v3.Drive | null = null;
  private rootFolderId: string | null = null;

  private async getDrive(): Promise<drive_v3.Drive> {
    if (this.driveInstance) {
      return this.driveInstance;
    }

    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!keyFile) {
      throw new Error(
        "GOOGLE_APPLICATION_CREDENTIALS is not set. Cannot initialize Drive client."
      );
    }

    const auth = new GoogleAuth({
      keyFile,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });

    const client = await auth.getClient();
    this.driveInstance = google.drive({ version: "v3", auth: client as unknown as string });
    this.logger.log("Drive client initialized via service account.");

    return this.driveInstance;
  }

  private async getOrCreateFolder(
    drive: drive_v3.Drive,
    name: string,
    parentId: string | null,
  ): Promise<string> {
    const query = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false` +
      (parentId ? ` and '${parentId}' in parents` : '');
    const res = await drive.files.list({ q: query, fields: 'files(id)', pageSize: 1, supportsAllDrives: true });
    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id!;
    }
    const meta: drive_v3.Schema$File = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentId) meta.parents = [parentId];
    const created = await drive.files.create({ requestBody: meta, fields: 'id', supportsAllDrives: true });
    return created.data.id!;
  }

  async ensureRootFolder(): Promise<string> {
    if (this.rootFolderId) return this.rootFolderId;

    const configuredId = process.env.LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID;

    if (configuredId) {
      this.rootFolderId = configuredId;
      return this.rootFolderId;
    }

    const drive = await this.getDrive();
    this.rootFolderId = await this.getOrCreateFolder(drive, 'Listening_habits', null);
    return this.rootFolderId;
  }

  async ensureUserFolder(userId: string): Promise<string> {
    const drive = await this.getDrive();
    const rootId = await this.ensureRootFolder();
    const usersFolderId = await this.getOrCreateFolder(drive, 'users', rootId);
    return await this.getOrCreateFolder(drive, userId, usersFolderId);
  }

  async ensureChildFolder(drive: drive_v3.Drive, parentId: string, name: string): Promise<string> {
    return this.getOrCreateFolder(drive, name, parentId);
  }

  async writeListeningArchiveFile(payload: ListeningArchiveFilePayload): Promise<{
    ok: boolean;
    message: string;
    folderId?: string;
    fileId?: string;
    webViewLink?: string;
  }> {
    try {
      const drive = await this.getDrive();
      const userFolderId = await this.ensureUserFolder(payload.userId);
      const archiveFolderId = await this.ensureChildFolder(drive, userFolderId, "archive");

      const date = new Date(`${payload.archiveDate}T00:00:00.000Z`);
      const year = String(date.getUTCFullYear());
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");

      const yearFolderId = await this.ensureChildFolder(drive, archiveFolderId, `year=${year}`);
      const monthFolderId = await this.ensureChildFolder(drive, yearFolderId, `month=${month}`);

      const fileName = `listening-events-${payload.archiveDate}.jsonl`;
      const jsonl = payload.events.map((event) => JSON.stringify(event)).join("\n") + "\n";

      const result = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [monthFolderId],
          mimeType: "application/x-ndjson"
        },
        media: {
          mimeType: "application/x-ndjson",
          body: jsonl
        },
        fields: "id,name,webViewLink",
        supportsAllDrives: true
      });

      return {
        ok: true,
        message: `Archived ${payload.events.length} listening event(s) to ${fileName}.`,
        folderId: monthFolderId,
        fileId: result.data.id ?? undefined,
        webViewLink: result.data.webViewLink ?? undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Listening archive write failed: ${message}`);

      return { ok: false, message };
    }
  }

  async writeListeningRollupFile(payload: ListeningRollupFilePayload): Promise<{
    ok: boolean;
    message: string;
    folderId?: string;
    fileId?: string;
    webViewLink?: string;
  }> {
    try {
      const drive = await this.getDrive();
      const userFolderId = await this.ensureUserFolder(payload.userId);
      const rollupsFolderId = await this.ensureChildFolder(drive, userFolderId, "rollups");
      const month = payload.monthStart.slice(0, 7);
      const fileName = `listening-rollup-${month}.json`;

      const result = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [rollupsFolderId],
          mimeType: "application/json"
        },
        media: {
          mimeType: "application/json",
          body: JSON.stringify(payload, null, 2)
        },
        fields: "id,name,webViewLink",
        supportsAllDrives: true
      });

      return {
        ok: true,
        message: `Wrote monthly listening rollup ${fileName}.`,
        folderId: rollupsFolderId,
        fileId: result.data.id ?? undefined,
        webViewLink: result.data.webViewLink ?? undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Listening rollup write failed: ${message}`);

      return { ok: false, message };
    }
  }

  async exportData(
    userId: string,
    content: string,
    filename: string,
    mimeType: string = 'text/csv',
  ): Promise<string> {
    const drive = await this.getDrive();
    const userFolderId = await this.ensureUserFolder(userId);

    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [userFolderId],
      },
      media: { mimeType, body: content },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });
    return res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}`;
  }

  async listExports(userId: string): Promise<{ id: string; name: string; webViewLink: string | null; createdTime: string | null }[]> {
    const drive = await this.getDrive();
    const userFolderId = await this.ensureUserFolder(userId);
    const res = await drive.files.list({
      q: `'${userFolderId}' in parents and trashed=false`,
      fields: 'files(id, name, webViewLink, createdTime)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
    });
    return (res.data.files || []).map(f => ({
      id: f.id!,
      name: f.name!,
      webViewLink: f.webViewLink || null,
      createdTime: f.createdTime || null,
    }));
  }
}
