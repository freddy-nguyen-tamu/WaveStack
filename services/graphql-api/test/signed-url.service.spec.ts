import { ConfigService } from "@nestjs/config";
import { SignedUrlService } from "../src/storage/signed-url.service";

describe("SignedUrlService", () => {
  it("creates verifiable stream URLs", () => {
    const config = new ConfigService({
      SIGNED_URL_SECRET: "test-secret",
      STREAM_TOKEN_TTL_SECONDS: "60"
    });
    const service = new SignedUrlService(config);

    const url = service.createSignedStreamUrl("tracks/song/master.m3u8");
    const parsed = new URL(url, "http://localhost");

    expect(service.verifySignedStreamUrl(
      "tracks/song/master.m3u8",
      Number(parsed.searchParams.get("expires")),
      parsed.searchParams.get("signature") ?? ""
    )).toBe(true);
  });
});
