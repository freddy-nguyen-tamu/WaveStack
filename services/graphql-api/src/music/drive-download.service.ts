import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleAuth } from "google-auth-library";

type CachedToken = {
  token: string;
  expiresAt: number;
};

@Injectable()
export class DriveDownloadService {
  private readonly auth: GoogleAuth;
  private cachedToken: CachedToken | null = null;

  constructor(private readonly config: ConfigService) {
    this.auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"]
    });
  }

  async fetchMedia(fileId: string, range?: string): Promise<Response> {
    const token = await this.getAccessToken();

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`
    };

    if (range) {
      headers.range = range;
    }

    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
    );

    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");

    return fetch(url.toString(), { headers });
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.token;
    }

    const client = await this.auth.getClient();
    const response = await client.getAccessToken();
    const token = typeof response === "string" ? response : response?.token;

    if (!token) {
      throw new Error("Could not get Google Drive service-account access token.");
    }

    this.cachedToken = {
      token,
      expiresAt: Date.now() + 50 * 60 * 1000
    };

    return token;
  }
}
