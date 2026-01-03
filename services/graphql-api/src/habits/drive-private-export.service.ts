import { Injectable, Logger } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

// eslint-disable-next-line @typescript-eslint/no-explicit-any

@Injectable()
export class DrivePrivateExportService {
  private readonly logger = new Logger(DrivePrivateExportService.name);
  private drive: drive_v3.Drive | null = null;
  private rootFolderId: string | null = null;

  async initialize(accessToken: string, refreshToken: string): Promise<void> {
    const oauth = new OAuth2Client({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    });
    oauth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    this.drive = google.drive({ version: 'v3', auth: oauth as unknown as string });
    this.rootFolderId = null;
  }

  private async assertDrive(): Promise<drive_v3.Drive> {
    if (!this.drive) throw new Error('Drive not initialized');
    return this.drive;
  }

  private async getOrCreateFolder(
    drive: drive_v3.Drive,
    name: string,
    parentId: string | null,
  ): Promise<string> {
    const query = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false` +
      (parentId ? ` and '${parentId}' in parents` : '');
    const res = await drive.files.list({ q: query, fields: 'files(id)', pageSize: 1 });
    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id!;
    }
    const meta: drive_v3.Schema$File = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentId) meta.parents = [parentId];
    const created = await drive.files.create({ requestBody: meta, fields: 'id' });
    return created.data.id!;
  }

  async ensureRootFolder(): Promise<string> {
    const drive = await this.assertDrive();
    if (this.rootFolderId) return this.rootFolderId;
    this.rootFolderId = await this.getOrCreateFolder(drive, 'Listening_habits', null);
    return this.rootFolderId;
  }

  async ensureUserFolder(userId: string): Promise<string> {
    const drive = await this.assertDrive();
    const rootId = await this.ensureRootFolder();
    const usersFolderId = await this.getOrCreateFolder(drive, 'users', rootId);
    return await this.getOrCreateFolder(drive, userId, usersFolderId);
  }

  async exportData(
    userId: string,
    content: string,
    filename: string,
    mimeType: string = 'text/csv',
  ): Promise<string> {
    const drive = await this.assertDrive();
    const userFolderId = await this.ensureUserFolder(userId);

    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [userFolderId],
      },
      media: { mimeType, body: content },
      fields: 'id, webViewLink',
    });
    return res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}`;
  }

  async listExports(userId: string): Promise<{ id: string; name: string; webViewLink: string | null; createdTime: string | null }[]> {
    const drive = await this.assertDrive();
    const userFolderId = await this.ensureUserFolder(userId);
    const res = await drive.files.list({
      q: `'${userFolderId}' in parents and trashed=false`,
      fields: 'files(id, name, webViewLink, createdTime)',
      orderBy: 'createdTime desc',
    });
    return (res.data.files || []).map(f => ({
      id: f.id!,
      name: f.name!,
      webViewLink: f.webViewLink || null,
      createdTime: f.createdTime || null,
    }));
  }
}
