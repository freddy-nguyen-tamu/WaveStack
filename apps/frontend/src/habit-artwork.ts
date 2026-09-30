import type { HabitSummaryEntry, Song } from "./App";

// Share one normalized music index between the right rail and profile. Rebuilding
// every track's searchable metadata for every habit entry was O(entries * library).
const songIndexes = new WeakMap<Song[], { searchable: string[]; matches: Map<string, Song[]> }>();

function getIndex(songs: Song[]) {
  let index = songIndexes.get(songs);
  if (!index) {
    index = {
      searchable: songs.map(song => [
        song.artistName, song.title, song.albumTitle, song.fileName, ...(song.genreNames ?? [])
      ].filter(Boolean).join(" ").toLowerCase()),
      matches: new Map<string, Song[]>()
    };
    songIndexes.set(songs, index);
  }
  return index;
}

export function pickHabitArtworkSong(entry: HabitSummaryEntry, songs: Song[], entryIndex: number): Song | null {
  if (!songs.length) return null;
  const label = entry.label.trim().toLowerCase();
  const index = getIndex(songs);
  let matches = index.matches.get(label);
  if (!matches) {
    matches = label && label !== "unknown"
      ? songs.filter((_, i) => index.searchable[i].includes(label)) : [];
    index.matches.set(label, matches);
  }
  const candidates = matches.length ? matches : songs;
  const hash = Array.from(`${entry.label}:${entryIndex}`).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return candidates[Math.abs(hash) % candidates.length] ?? null;
}
