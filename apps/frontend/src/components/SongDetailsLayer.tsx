import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { ClientPlaylist, PlaybackContext, Song } from "../App";
import { SongMetadataModal } from "../features/dashboard/SongMetadataModal";
import { WHEEL_GHOST_MS } from "../hooks/wheelHandoff";

type Details = { song: Song; context: PlaybackContext | null };

// Dialog state is independent from the route and library: showing song details
// must not cause the entire song list and fixed navigation rails to rerender.
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
  const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [retained, setRetained] = useState<Details | null>(current);

  useLayoutEffect(() => {
    if (current) {
      setRetained(current);
      return;
    }
    // Keep the same *scrollable DOM node* connected through the browser's
    // wheel-gesture transaction. The released layer is invisible, has no focus
    // targets and receives no new pointer hit tests. Dropping it immediately
    // can strand subsequent wheel ticks until the pointer moves.
    let timer: number;
    const scheduleRelease = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRetained(null), WHEEL_GHOST_MS);
    };
    // A continuous wheel transaction can outlast a fixed close animation.
    // Release the ghost only when the wheel has actually been quiet.
    window.addEventListener("wheel", scheduleRelease, { capture: true, passive: true });
    scheduleRelease();
    return () => {
      window.removeEventListener("wheel", scheduleRelease, true);
      window.clearTimeout(timer);
    };
  }, [current]);

  const details = current ?? retained;
  if (!details) return null;

  const { song, context } = details;
  return (
    <SongMetadataModal
      open={current !== null}
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
