import { createContext, useContext, type ReactNode } from "react";

export type NowPlayingState = {
  activeSongId: string | null;
  isPlaying: boolean;
  hasPlaybackHistory: boolean;
  discBaseAngleDeg: number;
  discStartedAtMs: number | null;
};

export const NOW_PLAYING_DISC_ROTATION_MS = 18000;
export const NOW_PLAYING_DISC_DEGREES_PER_MS = 360 / NOW_PLAYING_DISC_ROTATION_MS;

const emptyNowPlayingState: NowPlayingState = {
  activeSongId: null,
  isPlaying: false,
  hasPlaybackHistory: false,
  discBaseAngleDeg: 0,
  discStartedAtMs: null
};

const NowPlayingContext = createContext<NowPlayingState>(emptyNowPlayingState);

type NowPlayingProviderProps = {
  value: NowPlayingState;
  children: ReactNode;
};

export function NowPlayingProvider({ value, children }: NowPlayingProviderProps) {
  return (
    <NowPlayingContext.Provider value={value}>
      {children}
    </NowPlayingContext.Provider>
  );
}

export function useNowPlayingForSong(songId: string | null | undefined) {
  const state = useContext(NowPlayingContext);
  const isNowPlaying = Boolean(
    songId &&
    state.hasPlaybackHistory &&
    state.activeSongId === songId
  );

  return {
    isNowPlaying,
    isPlaying: isNowPlaying && state.isPlaying,
    discBaseAngleDeg: state.discBaseAngleDeg,
    discStartedAtMs: state.discStartedAtMs
  };
}
