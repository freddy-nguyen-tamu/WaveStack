import { Injectable, Logger } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { DatabaseService } from "../database/database.service";

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

  constructor(
    private readonly database: DatabaseService
  ) {}

  private driveInstance: drive_v3.Drive | null = null;
  private rootFolderId: string | null = null;

  static normalizeConfiguredFolderId(value: string | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed === "TODO_FILL_LATER" || trimmed === "REPLACE_ME") return null;
    return trimmed;
  }

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
      scopes: ["https://www.googleapis.com/auth/drive"],
    });

    const client = await auth.getClient();
    this.driveInstance = google.drive({ version: "v3", auth: client as any });
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

  async getUserDrive(refreshToken: string): Promise<drive_v3.Drive> {
    const oauth = new OAuth2Client({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_OAUTH_CALLBACK_URL
    });

    oauth.setCredentials({ refresh_token: refreshToken });

    return google.drive({ version: "v3", auth: oauth as any });
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

  async ensureRootFolderAsUser(
    userId: string,
    refreshToken: string
  ): Promise<{ id: string; webViewLink?: string }> {
    const drive = await this.getUserDrive(refreshToken);
    const existing = await this.database.query(
      `SELECT root_folder_id, root_folder_web_view_link
       FROM app_user_drive_archive_roots
       WHERE user_id = $1`,
      [userId]
    );
    const existingRow = existing.rows[0] as { root_folder_id: string; root_folder_web_view_link?: string } | undefined;
    if (existingRow?.root_folder_id) {
      try {
        const verify = await drive.files.get({
          fileId: existingRow.root_folder_id,
          fields: "id,webViewLink",
          supportsAllDrives: true
        });
        return { id: verify.data.id!, webViewLink: verify.data.webViewLink ?? undefined };
      } catch {
        this.logger.warn(`Root folder ${existingRow.root_folder_id} not accessible, creating new`);
      }
    }
    const configured = process.env.LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID;
    const normalized = DrivePrivateExportService.normalizeConfiguredFolderId(configured);
    if (normalized) {
      try {
        const verify = await drive.files.get({
          fileId: normalized,
          fields: "id,webViewLink",
          supportsAllDrives: true
        });
        await this.database.query(
          `INSERT INTO app_user_drive_archive_roots (user_id, root_folder_id, root_folder_web_view_link)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE SET
             root_folder_id = EXCLUDED.root_folder_id,
             root_folder_web_view_link = EXCLUDED.root_folder_web_view_link,
             updated_at = now()`,
          [userId, normalized, verify.data.webViewLink ?? null]
        );
        return { id: normalized, webViewLink: verify.data.webViewLink ?? undefined };
      } catch {
        this.logger.warn(`Configured folder ${normalized} not accessible, creating new`);
      }
    }
    const created = await drive.files.create({
      requestBody: {
        name: "Listening_habits",
        mimeType: "application/vnd.google-apps.folder",
        appProperties: {
          wavestack: "true",
          wavestackKind: "listening_habits_root"
        }
      },
      fields: "id,webViewLink",
      supportsAllDrives: true
    });
    await this.database.query(
      `INSERT INTO app_user_drive_archive_roots (user_id, root_folder_id, root_folder_web_view_link)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         root_folder_id = EXCLUDED.root_folder_id,
         root_folder_web_view_link = EXCLUDED.root_folder_web_view_link,
         updated_at = now()`,
      [userId, created.data.id!, created.data.webViewLink ?? null]
    );
    return { id: created.data.id!, webViewLink: created.data.webViewLink ?? undefined };
  }

  async readListeningArchiveFileAsUser(
    refreshToken: string,
    fileId: string
  ): Promise<ArchivedListeningEvent[]> {
    const drive = await this.getUserDrive(refreshToken);
    const response = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "text" }
    );
    const text = String(response.data ?? "");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ArchivedListeningEvent);
  }

  async listListeningArchiveFilesAsUser(
    userId: string,
    refreshToken: string,
    fromDate: string,
    toDate: string
  ): Promise<Array<{ fileId: string; name: string; archiveDate: string; webViewLink?: string }>> {
    const root = await this.ensureRootFolderAsUser(userId, refreshToken);
    const drive = await this.getUserDrive(refreshToken);
    const allFiles: Array<{ fileId: string; name: string; archiveDate: string; webViewLink?: string }> = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `mimeType='application/x-ndjson' and trashed=false and appProperties has { key='wavestackKind' and value='listening_events_archive' } and appProperties has { key='userId' and value='${userId}' }`,
        fields: "nextPageToken, files(id, name, webViewLink, appProperties)",
        pageSize: 100,
        pageToken,
        supportsAllDrives: true
      });
      for (const file of res.data.files ?? []) {
        const name = file.name ?? "";
        const match = name.match(/^listening-events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!match) continue;
        const archiveDate = match[1];
        if (archiveDate < fromDate || archiveDate > toDate) continue;
        allFiles.push({
          fileId: file.id!,
          name,
          archiveDate,
          webViewLink: file.webViewLink ?? undefined
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return allFiles;
  }

  private async ensureRootFolderDbRow(
    userId: string,
    rootFolderId: string,
    webViewLink?: string
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO app_user_drive_archive_roots (user_id, root_folder_id, root_folder_name, root_folder_web_view_link)
       VALUES ($1, $2, 'Listening_habits', $3)
       ON CONFLICT (user_id) DO UPDATE SET
         root_folder_id = EXCLUDED.root_folder_id,
         root_folder_web_view_link = EXCLUDED.root_folder_web_view_link,
         root_folder_name = EXCLUDED.root_folder_name,
         updated_at = now()`,
      [userId, rootFolderId, webViewLink ?? null]
    );
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

  async writeListeningArchiveFileAsUser(
    payload: ListeningArchiveFilePayload,
    refreshToken: string
  ): Promise<{
    ok: boolean;
    message: string;
    folderId?: string;
    fileId?: string;
    webViewLink?: string;
  }> {
    try {
      const drive = await this.getUserDrive(refreshToken);
      const root = await this.ensureRootFolderAsUser(payload.userId, refreshToken);
      const rootId = root.id;
      const usersFolderId = await this.ensureChildFolder(drive, rootId, "users");
      const userFolderId = await this.ensureChildFolder(drive, usersFolderId, payload.userId);
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
          mimeType: "application/x-ndjson",
          appProperties: {
            wavestack: "true",
            wavestackKind: "listening_events_archive",
            userId: payload.userId,
            archiveDate: payload.archiveDate
          }
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
      this.logger.error(`Listening archive write (user OAuth) failed: ${message}`);

      return { ok: false, message };
    }
  }

  async writeListeningRollupFileAsUser(
    payload: ListeningRollupFilePayload,
    refreshToken: string
  ): Promise<{
    ok: boolean;
    message: string;
    folderId?: string;
    fileId?: string;
    webViewLink?: string;
  }> {
    try {
      const drive = await this.getUserDrive(refreshToken);
      const root = await this.ensureRootFolderAsUser(payload.userId, refreshToken);
      const rootId = root.id;
      const usersFolderId = await this.ensureChildFolder(drive, rootId, "users");
      const userFolderId = await this.ensureChildFolder(drive, usersFolderId, payload.userId);
      const rollupsFolderId = await this.ensureChildFolder(drive, userFolderId, "rollups");
      const month = payload.monthStart.slice(0, 7);
      const fileName = `listening-rollup-${month}.json`;

      const result = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [rollupsFolderId],
          mimeType: "application/json",
          appProperties: {
            wavestack: "true",
            wavestackKind: "listening_rollup",
            userId: payload.userId,
            monthStart: payload.monthStart
          }
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
      this.logger.error(`Listening rollup write (user OAuth) failed: ${message}`);

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
