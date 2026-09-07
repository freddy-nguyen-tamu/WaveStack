// Local-only slow API for checking pagination, empty searches and artwork loading.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const cover = await readFile(new URL("../../favicon.ico", import.meta.url));
const songs = Array.from({ length: 240 }, (_, index) => ({
  __typename: "Song", id: `fixture-${index}`, title: `Track ${String(index + 1).padStart(3, "0")}`,
  artistName: `Artist ${index % 10}`, fileName: `original-recording-${index}.mp3`, albumTitle: "Test album",
  durationSeconds: 120, streamUrl: "/demo/monkeys-spinning-monkeys.mp3", genreNames: ["Instrumental"],
  thumbnailUrl: `http://localhost:4175/cover/${index}`, localThumbnailUrl: null, driveThumbnailUrl: null,
  embeddedArtworkUrl: null, score: 1, addedAt: null, modifiedTime: null, sizeBytes: null
}));
createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
  if (req.method === "OPTIONS") { res.end(); return; }
  if (req.url.startsWith("/cover/")) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    res.setHeader("Content-Type", "image/x-icon");
    res.end(cover); return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const { operationName, variables = {} } = JSON.parse(body);
    let data;
    if (operationName === "SongPage") {
      const matched = songs.filter(song => [song.fileName, song.title, song.artistName].join(" ").toLowerCase().includes((variables.query || "").toLowerCase()));
      const offset = Number(variables.after || 0), end = offset + (variables.first || 60);
      data = { songPage: { nodes: matched.slice(offset, end), totalCount: matched.length, pageInfo: { hasNextPage: end < matched.length, endCursor: end < matched.length ? String(end) : null } } };
    } else if (operationName === "SongDetails") {
      data = { songDetails: { ...songs.find(song => song.id === variables.id), lyrics: "Instrumental demo track.", webViewLink: null, mimeType: "audio/mpeg", sourceRootFolderId: null } };
    } else {
      data = { dashboardSongs: songs.slice(0, 12), playlists: [], recentlyPlayed: [], recommendations: [], driveSyncStatus: { status: "success", scannedCount: 240, upsertedCount: 240, thumbnailCount: 240, deletedCount: 0, startedAt: null, finishedAt: null, errorMessage: null }, favorites: [], mySongs: [], me: null };
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data }));
  } catch { res.writeHead(400).end(); }
}).listen(4175, "127.0.0.1", () => console.log("Fixture API: http://localhost:4175/graphql"));
