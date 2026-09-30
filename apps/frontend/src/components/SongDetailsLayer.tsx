import { useSyncExternalStore } from "react";
import type { ClientPlaylist, PlaybackContext, Song } from "../App";
import { SongMetadataModal } from "../features/dashboard/SongMetadataModal";

type Details = { song: Song; context: PlaybackContext | null };

// An overlay is transient UI state, not library state. Keeping it outside App's
// React state prevents opening/closing a dialog from rerendering every route,
// song row, image, navigation item, and listening-habits rail.
export function createSongDetailsStore() {
  let snapshot: Details | null = null;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    open(song: Song, context: PlaybackContext | null = null) {
      snapshot = { song, context };
      publish();
    },
    close() {
      if (snapshot === null) return;
      snapshot = null;
      publish();
    },
    followPlayback(previousId: string, song: Song, context: PlaybackContext | null) {
      if (snapshot?.song.id !== previousId) return;
      snapshot = { song, context };
      publish();
    }
  };
}

type SongDetailsLayerProps = {
  store: ReturnType<typeof createSongDetailsStore>;
  favoriteIds: string[];
  playlists: ClientPlaylist[];
  onPlay: (song: Song, context: PlaybackContext | null) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void | Promise<void>;
};

export function SongDetailsLayer({
  store,
  favoriteIds,
  playlists,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist
}: SongDetailsLayerProps) {
  const details = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!details) return null;

  const { song, context } = details;
  return (
    <SongMetadataModal
      song={song}
      onPlay={() => onPlay(song, context)}
      onQueue={() => onQueue(song)}
      isFavorite={favoriteIds.includes(song.id)}
      playlists={playlists}
      onToggleFavorite={() => onToggleFavorite(song)}
      onAddToPlaylist={(playlistId) => onAddToPlaylist(playlistId, song)}
      onClose={store.close}
    />
  );
}
