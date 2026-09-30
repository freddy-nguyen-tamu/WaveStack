import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";

export type NowPlayingState = {
  activeSongId: string | null;
  isPlaying: boolean;
  hasPlaybackHistory: boolean;
  discBaseAngleDeg: number;
  discStartedAtMs: number | null;
};

export type PlaybackVisualState = Pick<
  NowPlayingState,
  "isPlaying" | "hasPlaybackHistory" | "discBaseAngleDeg" | "discStartedAtMs"
>;

export const NOW_PLAYING_DISC_ROTATION_MS = 18000;
export const NOW_PLAYING_DISC_DEGREES_PER_MS = 360 / NOW_PLAYING_DISC_ROTATION_MS;

const EMPTY_STATE: NowPlayingState = {
  activeSongId: null,
  isPlaying: false,
  hasPlaybackHistory: false,
  discBaseAngleDeg: 0,
  discStartedAtMs: null
};

type SongVisualState = {
  isNowPlaying: boolean;
  isPlaying: boolean;
  discBaseAngleDeg: number;
  discStartedAtMs: number | null;
};
const INACTIVE: SongVisualState = Object.freeze({
  isNowPlaying: false,
  isPlaying: false,
  discBaseAngleDeg: 0,
  discStartedAtMs: null
});

// Playback must not be React state in App: an audio event should invalidate only
// the artwork/row of the previous and current songs, never the complete route.
export function createNowPlayingStore() {
  let state: NowPlayingState = EMPTY_STATE;
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, SongVisualState>();

  function makeSnapshot(id: string): SongVisualState {
    if (!id || !state.hasPlaybackHistory || id !== state.activeSongId) return INACTIVE;
    return {
      isNowPlaying: true,
      isPlaying: state.isPlaying,
      discBaseAngleDeg: state.discBaseAngleDeg,
      discStartedAtMs: state.discStartedAtMs
    };
  }

  function getSongSnapshot(id: string | null | undefined): SongVisualState {
    if (!id) return INACTIVE;
    const existing = snapshots.get(id);
    if (existing) return existing;
    const next = makeSnapshot(id);
    snapshots.set(id, next);
    return next;
  }

  function publish(ids: Array<string | null>) {
    for (const id of new Set(ids)) {
      if (!id) continue;
      const previous = snapshots.get(id);
      const next = makeSnapshot(id);
      if (previous && previous.isNowPlaying === next.isNowPlaying &&
        previous.isPlaying === next.isPlaying &&
        previous.discBaseAngleDeg === next.discBaseAngleDeg &&
        previous.discStartedAtMs === next.discStartedAtMs) continue;
      snapshots.set(id, next);
      listeners.get(id)?.forEach((listener) => listener());
    }
  }

  return {
    getState: () => state,
    getSongSnapshot,
    subscribeSong(id: string | null | undefined, listener: () => void) {
      if (!id) return () => {};
      let subscribers = listeners.get(id);
      if (!subscribers) {
        subscribers = new Set();
        listeners.set(id, subscribers);
      }
      subscribers.add(listener);
      return () => {
        subscribers!.delete(listener);
        if (!subscribers!.size) {
          listeners.delete(id);
          snapshots.delete(id);
        }
      };
    },
    setActiveSongId(id: string | null) {
      if (id === state.activeSongId) return;
      const previous = state.activeSongId;
      state = { ...state, activeSongId: id };
      publish([previous, id]);
    },
    setPlaybackState(next: PlaybackVisualState) {
      if (state.isPlaying === next.isPlaying &&
        state.hasPlaybackHistory === next.hasPlaybackHistory &&
        state.discBaseAngleDeg === next.discBaseAngleDeg &&
        state.discStartedAtMs === next.discStartedAtMs) return;
      state = { ...state, ...next };
      publish([state.activeSongId]);
    }
  };
}

export type NowPlayingStore = ReturnType<typeof createNowPlayingStore>;
const fallbackStore = createNowPlayingStore();
const NowPlayingContext = createContext<NowPlayingStore>(fallbackStore);

export function NowPlayingProvider({ store, children }: { store: NowPlayingStore; children: ReactNode }) {
  return <NowPlayingContext.Provider value={store}>{children}</NowPlayingContext.Provider>;
}

export function useNowPlayingForSong(songId: string | null | undefined): SongVisualState {
  const store = useContext(NowPlayingContext);
  const subscribe = useCallback((listener: () => void) => store.subscribeSong(songId, listener), [store, songId]);
  const snapshot = useCallback(() => store.getSongSnapshot(songId), [store, songId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
