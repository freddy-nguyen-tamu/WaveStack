import { createContext, useContext, type ReactNode } from "react";

export type NowPlayingState = {
  activeSongId: string | null;
  isPlaying: boolean;
  hasPlaybackHistory: boolean;
};

const emptyNowPlayingState: NowPlayingState = {
  activeSongId: null,
  isPlaying: false,
  hasPlaybackHistory: false
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
    isPlaying: isNowPlaying && state.isPlaying
  };
}
