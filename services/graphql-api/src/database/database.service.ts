import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, PoolClient } from "pg";

@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | null = null;

  constructor(private readonly config: ConfigService) {}

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        host: this.config.get<string>("POSTGRES_HOST") ?? "postgres",
        port: this.config.get<number>("POSTGRES_PORT") ?? 5432,
        database: this.config.get<string>("POSTGRES_DB") ?? "wavestack",
        user: this.config.get<string>("POSTGRES_USER") ?? "wavestack",
        password: this.config.get<string>("POSTGRES_PASSWORD") ?? ""
      });
    }

    return this.pool;
  }

  async query(text: string, params?: unknown[]): Promise<unknown[]> {
    const pool = this.getPool();

    try {
      const result = await pool.query(text, params);
      return result.rows;
    } catch (error) {
      this.logger.error(`Database query failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getClient(): Promise<PoolClient> {
    const pool = this.getPool();
    return pool.connect();
  }
}
