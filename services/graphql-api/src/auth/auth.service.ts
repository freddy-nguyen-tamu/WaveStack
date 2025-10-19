import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { DatabaseService } from "../database/database.service";
import { AuthUser } from "./auth.models";

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

  private get oauthClientId(): string {
    return this.config.get<string>("GOOGLE_OAUTH_CLIENT_ID") ?? "";
  }

  private get oauthClientSecret(): string {
    return this.config.get<string>("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
  }

  private get oauthCallbackUrl(): string {
    return this.config.get<string>("GOOGLE_OAUTH_CALLBACK_URL") ?? "";
  }

  createOAuth2Client() {
    return new OAuth2Client({
      clientId: this.oauthClientId,
      clientSecret: this.oauthClientSecret,
      redirectUri: this.oauthCallbackUrl
    });
  }

  getGoogleAuthUrl(): string {
    const client = this.createOAuth2Client();
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile"
      ]
    });
  }

  async authenticateWithGoogleCode(code: string): Promise<{ token: string; user: AuthUser }> {
    const client = this.createOAuth2Client();
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new UnauthorizedException("No id_token returned from Google");
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.oauthClientId
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new UnauthorizedException("Invalid Google token payload");
    }

    const googleId = payload.sub;
    const email = payload.email;
    const displayName = payload.name ?? email.split("@")[0];
    const avatarUrl = payload.picture ?? null;

    const existing = await this.database.query<AppUserRow>(
      "SELECT id, email, display_name, avatar_url FROM app_users WHERE email = $1",
      [email]
    );

    let userRow: AppUserRow;

    if (existing.rows.length > 0) {
      userRow = existing.rows[0];
      await this.database.query(
        "UPDATE app_users SET display_name = $1, avatar_url = COALESCE($2, avatar_url), google_id = $3 WHERE id = $4",
        [displayName, avatarUrl, googleId, userRow.id]
      );
      userRow.display_name = displayName;
      userRow.avatar_url = avatarUrl ?? userRow.avatar_url;
    } else {
      const result = await this.database.query<AppUserRow>(
        `INSERT INTO app_users (email, display_name, avatar_url, google_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, avatar_url`,
        [email, displayName, avatarUrl, googleId]
      );
      userRow = result.rows[0];
    }

    const token = this.createToken(userRow.id, userRow.email);

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

  private createToken(userId: string, email: string): string {
    return jwt.sign({ userId, email }, this.jwtSecret, { expiresIn: "7d" });
  }
}

type AppUserRow = {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
};
