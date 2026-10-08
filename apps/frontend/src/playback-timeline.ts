/**
 * The playback path, including the portion ahead of the cursor after Previous.
 * Tracks are retained by reference: navigating an existing path never reshuffles
 * or duplicates song metadata. Only a genuinely new selection extends the path.
 */
export function createPlaybackTimeline<Song>(maximumEntries = 10_000) {
  let entries: Song[] = [];
  let position = -1;

  return {
    reset(song: Song): void {
      entries = [song];
      position = 0;
    },

    current(): Song | null {
      return position >= 0 ? entries[position] ?? null : null;
    },

    hasPrevious(): boolean {
      return position > 0;
    },

    previous(): Song | null {
      if (position <= 0) return null;
      return entries[--position] ?? null;
    },

    peekNext(): Song | null {
      return entries[position + 1] ?? null;
    },

    next(): Song | null {
      if (position >= entries.length - 1) return null;
      return entries[++position] ?? null;
    },

    append(song: Song): void {
      if (position < 0) {
        entries = [song];
        position = 0;
        return;
      }

      // Branching onto a newly chosen track discards only the forward path.
      // Ordinary Next must use next() instead and preserve that path.
      entries.length = position + 1;
      entries.push(song);
      position += 1;

      if (entries.length > maximumEntries) {
        const count = entries.length - maximumEntries;
        entries.splice(0, count);
        position -= count;
      }
    },

    prepend(song: Song): void {
      // Used for sequential Previous when there is no visited predecessor.
      // Keep the old current song as the next entry, so Next reverses the step.
      if (position < 0) {
        entries = [song];
        position = 0;
        return;
      }
      entries.unshift(song);
      position = 0;
      if (entries.length > maximumEntries) entries.length = maximumEntries;
    },

    replaceCurrent(song: Song): void {
      if (position >= 0) entries[position] = song;
    },

    past(): Song[] {
      return entries.slice(0, Math.max(0, position));
    }
  };
}
