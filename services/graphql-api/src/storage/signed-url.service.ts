import { createHmac } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SignedUrlService {
  constructor(private readonly config: ConfigService) {}

  createSignedStreamUrl(path: string): string {
    const ttlSeconds = Number(this.config.get<string>("STREAM_TOKEN_TTL_SECONDS") ?? "900");
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const secret = this.config.get<string>("SIGNED_URL_SECRET") ?? "dev-only-secret";
    const signature = createHmac("sha256", secret)
      .update(`${path}:${expires}`)
      .digest("hex");

    return `/stream/${encodeURIComponent(path)}?expires=${expires}&signature=${signature}`;
  }

  verifySignedStreamUrl(path: string, expires: number, signature: string): boolean {
    if (expires < Math.floor(Date.now() / 1000)) return false;

    const secret = this.config.get<string>("SIGNED_URL_SECRET") ?? "dev-only-secret";
    const expected = createHmac("sha256", secret)
      .update(`${path}:${expires}`)
      .digest("hex");

    return expected === signature;
  }
}
