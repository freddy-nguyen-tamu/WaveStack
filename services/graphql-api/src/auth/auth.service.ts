import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { DatabaseService } from "../database/database.service";
import { AuthPayload, AuthUser } from "./auth.models";

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

  async register(email: string, displayName: string, password: string): Promise<AuthPayload> {
    const existing = await this.database.query(
      "SELECT id FROM app_users WHERE email = $1",
      [email]
    );

    if (existing.length > 0) {
      throw new UnauthorizedException("Email already registered");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const rows = await this.database.query(
      "INSERT INTO app_users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at",
      [email, displayName, passwordHash]
    );

    const user = rows[0] as AuthUserRow;
    const token = this.createToken(user.id, user.email);

    return {
      token,
      user: this.toAuthUser(user)
    };
  }

  async login(email: string, password: string): Promise<AuthPayload> {
    const rows = await this.database.query(
      "SELECT id, email, display_name, password_hash, created_at FROM app_users WHERE email = $1",
      [email]
    );

    if (rows.length === 0) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const user = rows[0] as AuthUserRow;

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const token = this.createToken(user.id, user.email);

    return {
      token,
      user: this.toAuthUser(user)
    };
  }

  async me(userId: string): Promise<AuthUser> {
    const rows = await this.database.query(
      "SELECT id, email, display_name, created_at FROM app_users WHERE id = $1",
      [userId]
    );

    if (rows.length === 0) {
      throw new UnauthorizedException("User not found");
    }

    return this.toAuthUser(rows[0] as AuthUserRow);
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

  private toAuthUser(row: AuthUserRow): AuthUser {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at
    };
  }
}

type AuthUserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: string;
};
