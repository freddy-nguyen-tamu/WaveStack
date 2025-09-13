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

/*
  Stronger duration weighting for dashboard cards.

  The old logic only returned four broad classes, so a 3-minute song and a
  6-minute song often looked too similar. This returns a continuous rem height.

  The exponent makes long songs visually much larger:
  - shortest songs stay near 12rem
  - median songs land around 18rem-22rem
  - long songs can reach 34rem
*/
export function getSongCardHeightRem(
  song: Pick<Song, "durationSeconds">,
  allSongs: Array<Pick<Song, "durationSeconds">>
): number {
  const duration = Math.max(1, song.durationSeconds || 0);
  const durations = allSongs
    .map((item) => item.durationSeconds || 0)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!durations.length) {
    return 16;
  }

  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);

  if (maxDuration <= minDuration) {
    return 18;
  }

  const normalized = (duration - minDuration) / (maxDuration - minDuration);
  const weighted = Math.pow(Math.max(0, Math.min(1, normalized)), 1.55);

  return Math.round((12 + weighted * 22) * 10) / 10;
}

function normalizeLabelPart(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || fallback;
}
