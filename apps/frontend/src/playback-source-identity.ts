function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function driveFileIdFromSongId(songId: string): string | null {
  if (!songId.startsWith("drive-")) {
    return null;
  }

  const fileId = songId.slice("drive-".length).trim();
  return fileId || null;
}

export function driveFileIdFromStreamUrl(streamUrl: string, baseUrl?: string): string | null {
  if (!streamUrl) {
    return null;
  }

  try {
    const fallbackBase = baseUrl ?? globalThis.location?.href ?? "http://wavestack.local/";
    const url = new URL(streamUrl, fallbackBase);
    const match = safeDecode(url.pathname).match(/\/drive\/stream\/([^/]+)\/?$/i);
    return match?.[1] ? safeDecode(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Drive song identity is encoded twice in WaveStack:
 *   song.id      = drive-<google-drive-file-id>
 *   song.streamUrl = .../drive/stream/<google-drive-file-id>?...
 *
 * Those values must never disagree. A signed URL can expire and its query string
 * can change, but the path file ID is immutable for that song.
 */
export function streamUrlBelongsToSong(songId: string, streamUrl: string, baseUrl?: string): boolean {
  const expectedFileId = driveFileIdFromSongId(songId);

  // User uploads and other non-Drive sources do not encode song identity in this path.
  if (!expectedFileId) {
    return true;
  }

  const actualFileId = driveFileIdFromStreamUrl(streamUrl, baseUrl);
  return actualFileId === expectedFileId;
}

export function assertStreamUrlBelongsToSong(songId: string, streamUrl: string, baseUrl?: string): void {
  if (streamUrlBelongsToSong(songId, streamUrl, baseUrl)) {
    return;
  }

  const expectedFileId = driveFileIdFromSongId(songId);
  const actualFileId = driveFileIdFromStreamUrl(streamUrl, baseUrl);
  throw new Error(
    `WaveStack refused a playback link for the wrong Drive file (song ${songId}, expected ${expectedFileId ?? "n/a"}, got ${actualFileId ?? "unrecognized"}).`
  );
}
