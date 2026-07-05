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
  private inFlightTokenRequest: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {
    this.auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"]
    });
  }

  async fetchMedia(fileId: string, range?: string): Promise<Response> {
    const token = await this.getAccessToken();
    const response = await this.requestMedia(fileId, range, token);

    // The cached service-account token can go stale (early revocation, clock
    // drift, or it simply expired a little before our cached TTL assumed it
    // would). When that happens Google returns 401/403 even though the file
    // itself is fine. Instead of forwarding that transient failure straight
    // to the browser (where it can get cached and "stick" for the client),
    // drop the cached token and retry once with a freshly minted one.
    if (response.status === 401 || response.status === 403) {
      this.cachedToken = null;
      const freshToken = await this.getAccessToken();
      return this.requestMedia(fileId, range, freshToken);
    }

    return response;
  }

  private requestMedia(fileId: string, range: string | undefined, token: string): Promise<Response> {
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

    // Coalesce concurrent refreshes so a burst of simultaneous song
    // requests (e.g. prefetching the next track) doesn't fire off a dozen
    // parallel token requests the moment the cached token expires.
    if (!this.inFlightTokenRequest) {
      this.inFlightTokenRequest = this.refreshAccessToken().finally(() => {
        this.inFlightTokenRequest = null;
      });
    }

    return this.inFlightTokenRequest;
  }

  private async refreshAccessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const response = await client.getAccessToken();
    const token = typeof response === "string" ? response : response?.token;

    if (!token) {
      throw new Error("Could not get Google Drive service-account access token.");
    }

    // Prefer the real expiry Google reports; fall back to a conservative
    // 50 minute assumption only if it's missing. Trusting a hardcoded
    // 50-minute TTL regardless of what Google actually issued is what let
    // requests go out with an already-invalid token.
    const reportedExpiry =
      typeof response === "object" && response?.res?.data?.expiry_date
        ? Number(response.res.data.expiry_date)
        : null;

    this.cachedToken = {
      token,
      expiresAt: reportedExpiry && reportedExpiry > Date.now()
        ? reportedExpiry - 60 * 1000 // refresh 1 min before real expiry
        : Date.now() + 50 * 60 * 1000
    };

    return token;
  }
}
