import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, QueryResult, QueryResultRow } from "pg";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(private readonly config: ConfigService) {
    this.pool = new Pool({
      host: this.config.get<string>("POSTGRES_HOST") ?? "localhost",
      port: Number(this.config.get<string>("POSTGRES_PORT") ?? 5432),
      database: this.config.get<string>("POSTGRES_DB") ?? "wavestack",
      user: this.config.get<string>("POSTGRES_USER") ?? "wavestack",
      password: this.config.get<string>("POSTGRES_PASSWORD") ?? "wavestack_dev_password"
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
