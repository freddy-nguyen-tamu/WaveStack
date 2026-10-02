import { ConfigService } from "@nestjs/config";
import { DriveTrackRepository } from "../src/music/drive-track.repository";
import { SignedUrlService } from "../src/storage/signed-url.service";

describe("DriveTrackRepository stream identity", () => {
  it("reconstructs a Drive song stream from drive_file_id instead of trusting a crossed stream_url", () => {
    const config = new ConfigService({
      API_PUBLIC_ORIGIN: "https://api.wavestack.test",
      SIGNED_URL_SECRET: "test-secret",
      STREAM_TOKEN_TTL_SECONDS: "60"
    });
    const signedUrlService = new SignedUrlService(config);
    const repository = new DriveTrackRepository({} as never, config, signedUrlService) as unknown as {
      rowToSong: (row: Record<string, unknown>) => { id: string; streamUrl: string };
    };

    const song = repository.rowToSong({
      id: "drive-1OTq-current",
      drive_file_id: "1OTq-current",
      source_type: "drive",
      stream_url: "https://api.wavestack.test/drive/stream/1kie-previous?expires=1&signature=bad",
      file_name: "current.mp3",
      embedded_search: "",
      normalized_search: "current",
      title: "Current",
      artist_name: "Artist",
      album_title: "Album",
      duration_seconds: 120,
      genre_names: [],
      score: null,
      thumbnail_url: null,
      local_thumbnail_url: null,
      drive_thumbnail_url: null,
      embedded_artwork_url: null,
      lyrics: null,
      web_view_link: null,
      mime_type: "audio/mpeg",
      modified_time: null,
      drive_created_time: null,
      first_seen_at: null,
      size_bytes: null,
      source_root_folder_id: null,
      owner_user_id: null,
      title_locked: true
    });

    const parsed = new URL(song.streamUrl);
    expect(song.id).toBe("drive-1OTq-current");
    expect(parsed.pathname).toBe("/drive/stream/1OTq-current");
    expect(parsed.pathname).not.toContain("1kie-previous");
    expect(parsed.searchParams.get("expires")).toBeTruthy();
    expect(parsed.searchParams.get("signature")).toBeTruthy();
  });
});
