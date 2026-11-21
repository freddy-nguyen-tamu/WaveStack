import { PlaylistsService } from "./playlists.service";
import type { DatabaseService } from "../database/database.service";
import type { MusicService } from "../music/music.service";

function makeService(query: jest.Mock) {
  const database = { query } as unknown as DatabaseService;
  const music = { songDetails: jest.fn().mockResolvedValue(null) } as unknown as MusicService;
  return new PlaylistsService(database, music);
}

describe("playlist last-addition ordering", () => {
  it("lists accounts by last addition, not creation or last deletion", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [
      { id: "older", name: "Older", song_ids: [], song_count: 0,
        created_at: "2026-10-01T00:00:00Z", updated_at: "2026-11-20T00:00:00Z",
        last_song_added_at: "2026-11-19T00:00:00Z" },
      { id: "newer", name: "Newer", song_ids: [], song_count: 0,
        created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-18T00:00:00Z",
        last_song_added_at: "2026-11-17T00:00:00Z" }
    ] });
    const playlists = await makeService(query).getPlaylists("test-user");
    expect(playlists.map(playlist => playlist.id)).toEqual(["older", "newer"]);
    expect(playlists[0].lastSongAddedAt).toBe("2026-11-19T00:00:00.000Z");
    expect(query.mock.calls[0][0]).toContain("COALESCE(p.last_song_added_at, MAX(ps.added_at), p.created_at) DESC");
  });

  it("updates last-addition timestamp only if insertion actually occurred", async () => {
    const insert = async (inserted: boolean) => {
      const query = jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT id")) return { rows: [{ id: "playlist" }] };
        if (sql.includes("next_position")) return { rows: [{ next_position: 3 }] };
        if (sql.includes("RETURNING song_id")) return { rows: inserted ? [{ song_id: "song" }] : [] };
        return { rows: [] };
      });
      await makeService(query).addSongToPlaylist("user", "playlist", "song");
      return query.mock.calls.map(([sql]) => sql as string);
    };
    expect((await insert(true)).some(sql => sql.includes("SET last_song_added_at = now()"))).toBe(true);
    expect((await insert(false)).some(sql => sql.includes("SET last_song_added_at = now()"))).toBe(false);
  });

  it("snapshots legacy addition time before removal rather than during startup", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await makeService(query).removeSongFromPlaylist("user", "playlist", "song");
    const calls = query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));
    const snapshot = calls.findIndex(({ sql }) => sql.includes("SET last_song_added_at ="));
    const removal = calls.findIndex(({ sql }) => sql.includes("DELETE FROM app_user_playlist_songs"));
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(removal).toBeGreaterThan(snapshot);
    expect(calls[snapshot].sql).toContain("p.last_song_added_at IS NULL");
    expect(calls[snapshot].sql).toContain("MAX(ps.added_at)");
    expect(calls[snapshot].params).toEqual(["playlist", "user", "song"]);
    expect(calls.filter(({ sql }) => sql.includes("SET last_song_added_at ="))).toHaveLength(1);
  });
});
