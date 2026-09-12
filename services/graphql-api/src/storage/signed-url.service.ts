import { createHmac, timingSafeEqual } from "node:crypto";
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

  signExistingUrl(url: string): string {
    const ttlSeconds = Number(this.config.get<string>("STREAM_TOKEN_TTL_SECONDS") ?? "900");
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const secret = this.config.get<string>("SIGNED_URL_SECRET") ?? "dev-only-secret";
    const parsed = this.parseUrl(url);
    const path = parsed?.pathname ?? url.split("?")[0];
    const signature = createHmac("sha256", secret)
      .update(`${path}:${expires}`)
      .digest("hex");

    if (parsed) {
      parsed.searchParams.set("expires", String(expires));
      parsed.searchParams.set("signature", signature);
      if (url.startsWith("/")) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      return parsed.toString();
    }

    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}expires=${expires}&signature=${signature}`;
  }

  verifySignedStreamUrl(path: string, expires: number, signature: string): boolean {
    if (!Number.isFinite(expires)) return false;
    if (expires < Math.floor(Date.now() / 1000)) return false;

    const secret = this.config.get<string>("SIGNED_URL_SECRET") ?? "dev-only-secret";
    const expected = createHmac("sha256", secret)
      .update(`${path}:${expires}`)
      .digest("hex");

    const expectedBuffer = Buffer.from(expected, "hex");
    const actualBuffer = Buffer.from(signature, "hex");

    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  }

  private parseUrl(url: string): URL | null {
    try {
      return new URL(url, "http://wavestack.local");
    } catch {
      return null;
    }
  }
}
