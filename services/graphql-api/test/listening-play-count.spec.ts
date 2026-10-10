import { HabitsService } from "../src/habits/habits.service";

describe("listening events and profile play totals", () => {
  const userId = "user-test-id";
  const songId = "drive-looped-song";
  const query = jest.fn();
  const archive = { warmArchiveCacheForPeriod: jest.fn().mockResolvedValue(undefined) };
  const service = new HabitsService(
    { query } as never,
    {} as never,
    {} as never,
    {} as never,
    archive as never
  );

  beforeEach(() => {
    query.mockReset();
    archive.warmArchiveCacheForPeriod.mockClear();
  });

  it("inserts an individual event for every completed recording request, even for the same song", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(service.recordListen(userId, songId, "Artist", "Song", 60, 0)).resolves.toBe(true);
    await expect(service.recordListen(userId, songId, "Artist", "Song", 60, 0)).resolves.toBe(true);
    await expect(service.recordListen(userId, songId, "Artist", "Song", 60, 0)).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain("INSERT INTO app_listening_events");
      expect(params).toEqual([userId, songId, "Artist", "Song", 60, 0]);
    }
  });

  it("counts distinct listening event rows, including repeat plays, without double-counting time windows", async () => {
    query.mockResolvedValue({ rows: [{ count: "3" }] });
    await expect(service.listeningPlayCount(userId)).resolves.toBe(3);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("COUNT(*)");
    expect(sql).toContain("app_listening_events_combined");
    expect(sql).not.toContain("DISTINCT song_id");
    expect(params).toEqual([userId]);
  });
});
