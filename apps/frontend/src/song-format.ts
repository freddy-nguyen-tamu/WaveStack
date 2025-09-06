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

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) {
    return "Unknown";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function hasThumbnail(song: Pick<Song, "thumbnailUrl">): boolean {
  return Boolean(song.thumbnailUrl?.trim());
}

export function getSongCardSize(song: Pick<Song, "durationSeconds">, index: number): "small" | "medium" | "large" | "wide" {
  const duration = song.durationSeconds || 0;

  if (duration >= 420) {
    return "large";
  }

  if (duration >= 300) {
    return index % 3 === 0 ? "wide" : "large";
  }

  if (duration >= 180) {
    return "medium";
  }

  return index % 4 === 0 ? "wide" : "small";
}

function normalizeLabelPart(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || fallback;
}
