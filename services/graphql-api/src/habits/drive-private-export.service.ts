import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google } from "googleapis";

export type ListeningHabitExportPayload = {
  userId: string;
  generatedAt: string;
  period: "DAY" | "WEEK" | "MONTH" | "YEAR" | "ALL";
  events: Array<{
    songId: string;
    artistName: string;
    title: string;
    durationSeconds: number;
    completedPlayRatio: number;
    startedAt: string;
  }>;
  summaries: Record<string, unknown>;
};

@Injectable()
export class DrivePrivateExportService {
  private readonly logger = new Logger(DrivePrivateExportService.name);

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return this.config.get<string>("GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED") === "true";
  }

  getFolderId(): string {
    return this.config.get<string>("LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID") ?? "";
  }

  getCredentialsPath(): string {
    return this.config.get<string>("GOOGLE_APPLICATION_CREDENTIALS") ?? "";
  }

  async assertWritable(): Promise<{
    ok: boolean;
    message: string;
    folderId: string;
    credentialsPath: string;
    testFileId?: string;
    webViewLink?: string;
  }> {
    const folderId = this.getFolderId();
    const credentialsPath = this.getCredentialsPath();

    if (!this.isEnabled()) {
      return {
        ok: false,
        folderId,
        credentialsPath,
        message: "GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED is not true."
      };
    }

    if (!folderId || folderId === "TODO_FILL_LATER") {
      return {
        ok: false,
        folderId,
        credentialsPath,
        message: "LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID is missing or still TODO_FILL_LATER."
      };
    }

    if (!credentialsPath) {
      return {
        ok: false,
        folderId,
        credentialsPath,
        message: "GOOGLE_APPLICATION_CREDENTIALS is missing."
      };
    }

    try {
      const drive = await this.getDriveClient();

      const result = await drive.files.create({
        requestBody: {
          name: `wavestack-private-drive-write-test-${Date.now()}.json`,
          parents: [folderId],
          mimeType: "application/json"
        },
        media: {
          mimeType: "application/json",
          body: JSON.stringify(
            {
              ok: true,
              source: "WaveStack private Drive write test",
              createdAt: new Date().toISOString()
            },
            null,
            2
          )
        },
        fields: "id,name,webViewLink"
      });

      return {
        ok: true,
        folderId,
        credentialsPath,
        testFileId: result.data.id ?? undefined,
        webViewLink: result.data.webViewLink ?? undefined,
        message: `Successfully wrote ${result.data.name ?? "test file"} to the private Drive folder.`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Private Drive write test failed: ${message}`);

      return {
        ok: false,
        folderId,
        credentialsPath,
        message
      };
    }
  }

  async exportListeningHabits(payload: ListeningHabitExportPayload): Promise<{
    ok: boolean;
    fileId?: string;
    webViewLink?: string;
    message: string;
  }> {
    if (!this.isEnabled()) {
      return {
        ok: false,
        message: "Google Drive private export is disabled."
      };
    }

    const folderId = this.getFolderId();

    if (!folderId || folderId === "TODO_FILL_LATER") {
      return {
        ok: false,
        message: "Listening habits Drive folder ID is missing."
      };
    }

    try {
      const drive = await this.getDriveClient();
      const safeDate = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `wavestack-listening-habits-${payload.userId}-${payload.period.toLowerCase()}-${safeDate}.json`;

      const result = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [folderId],
          mimeType: "application/json"
        },
        media: {
          mimeType: "application/json",
          body: JSON.stringify(payload, null, 2)
        },
        fields: "id,name,webViewLink"
      });

      return {
        ok: true,
        fileId: result.data.id ?? undefined,
        webViewLink: result.data.webViewLink ?? undefined,
        message: `Exported listening habits to ${result.data.name ?? fileName}.`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Listening habit Drive export failed: ${message}`);

      return {
        ok: false,
        message
      };
    }
  }

  private async getDriveClient() {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.file"]
    });

    return google.drive({
      version: "v3",
      auth
    });
  }
}
