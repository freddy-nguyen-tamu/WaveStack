import type { Song } from "./App";

export function formatSongDisplayName(song: Pick<Song, "artistName" | "title">): string {
  const artist = normalizeLabelPart(song.artistName, "Unknown Artist");
  const title = normalizeLabelPart(song.title, "Untitled Track");

  return `${artist} - ${title}`;
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function normalizeLabelPart(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || fallback;
}
