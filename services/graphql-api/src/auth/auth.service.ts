import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { DatabaseService } from "../database/database.service";
import { AuthUser } from "./auth.models";

type GoogleUserInfo = {
  id: string;
  email: string;
  name?: string;
  picture?: string;
};

type AppUserRow = {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  google_refresh_token: string | null;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService
  ) {}

  private get jwtSecret(): string {
    return this.config.get<string>("JWT_SECRET") ?? "dev-secret-do-not-use-in-production";
  }

  private getOAuthClient(): OAuth2Client {
    const clientId = this.config.get<string>("GOOGLE_OAUTH_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_OAUTH_CLIENT_SECRET");
    const callbackUrl = this.config.get<string>("GOOGLE_OAUTH_CALLBACK_URL");

    if (!clientId) {
      throw new Error("GOOGLE_OAUTH_CLIENT_ID is missing.");
    }

    if (!clientSecret) {
      throw new Error("GOOGLE_OAUTH_CLIENT_SECRET is missing.");
    }

    if (!callbackUrl) {
      throw new Error("GOOGLE_OAUTH_CALLBACK_URL is missing.");
    }

    return new OAuth2Client({ clientId, clientSecret, redirectUri: callbackUrl });
  }

  getGoogleAuthUrl(): string {
    const client = this.getOAuthClient();

    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/drive.file"
      ]
    });
  }

  async handleGoogleCallback(code: string): Promise<{
    token: string;
    user: AuthUser;
  }> {
    const client = this.getOAuthClient();

    this.logger.log("[Google OAuth] Exchanging code for tokens");

    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    if (!tokens.access_token) {
      throw new Error("No access_token returned from Google");
    }

    this.logger.log("[Google OAuth] Fetching user info from Google");

    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` }
    });

    if (!userInfoResponse.ok) {
      throw new Error(`Could not fetch Google user info: ${userInfoResponse.status}`);
    }

    const googleUser = (await userInfoResponse.json()) as GoogleUserInfo;

    if (!googleUser.email) {
      throw new Error("Google account did not return an email address.");
    }

    const email = googleUser.email;
    const displayName = googleUser.name ?? email.split("@")[0];
    const avatarUrl = googleUser.picture ?? null;
    const refreshToken = tokens.refresh_token ?? null;

    this.logger.log(`[Google OAuth] Upserting user ${email}`);

    const userResult = await this.database.query<AppUserRow>(
      `INSERT INTO app_users (
        email, display_name, avatar_url, google_id, google_refresh_token
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        google_id = COALESCE(app_users.google_id, EXCLUDED.google_id),
        google_refresh_token = COALESCE(EXCLUDED.google_refresh_token, app_users.google_refresh_token)
      RETURNING id, email, display_name, avatar_url, google_refresh_token`,
      [email, displayName, avatarUrl, googleUser.id, refreshToken]
    );

    const userRow = userResult.rows[0];

    if (!userRow) {
      throw new Error("Could not create or load WaveStack user.");
    }

    const token = jwt.sign({ userId: userRow.id, email: userRow.email }, this.jwtSecret, {
      expiresIn: "7d"
    });

    this.logger.log(`[Google OAuth] Login successful for ${email}`);

    return {
      token,
      user: {
        id: userRow.id,
        email: userRow.email,
        displayName: userRow.display_name,
        avatarUrl: userRow.avatar_url ?? undefined
      }
    };
  }

  createOAuth2Client() {
    return this.getOAuthClient();
  }

  async authenticateWithGoogleCode(code: string): Promise<{ token: string; user: AuthUser }> {
    return this.handleGoogleCallback(code);
  }

  async me(userId: string): Promise<AuthUser | null> {
    const result = await this.database.query<AppUserRow>(
      "SELECT id, email, display_name, avatar_url FROM app_users WHERE id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      avatarUrl: row.avatar_url ?? undefined
    };
  }

  verifyToken(token: string): { userId: string; email: string } {
    try {
      return jwt.verify(token, this.jwtSecret) as { userId: string; email: string };
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
