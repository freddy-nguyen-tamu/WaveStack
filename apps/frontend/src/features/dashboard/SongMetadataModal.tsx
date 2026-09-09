import { createPortal } from "react-dom";
import { LyricSearch } from "./LyricSearch";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useMutation, useQuery } from "@apollo/client";
import type { ClientPlaylist, Song } from "../../App";
import {
  REPAIR_EMBEDDED_LYRICS_FOR_SONG_MUTATION,
  SONG_DETAILS_QUERY
} from "../../api";
import { formatSongDisplayName } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";
import { SongActions } from "../../components/SongActions";

type SongMetadataModalProps = {
  song: Song;
  onPlay: () => void;
  onQueue: () => void;
  isFavorite: boolean;
  playlists: ClientPlaylist[];
  onToggleFavorite: () => void;
  onAddToPlaylist: (playlistId: string) => void | Promise<void>;
  onClose: () => void;
};

type SongDetailsQueryData = {
  songDetails: Song | null;
};

type SongDetailsQueryVariables = {
  id: string;
};

type LyricsRepairMutationData = {
  repairEmbeddedLyricsForSong: {
    ok: boolean;
    message: string;
    attemptedCount: number;
    repairedCount: number;
    failedCount: number;
  };
};

type LyricsRepairMutationVariables = {
  songId: string;
};

export function SongMetadataModal({
  song,
  onPlay,
  onQueue,
  isFavorite,
  playlists,
  onToggleFavorite,
  onAddToPlaylist,
  onClose
}: SongMetadataModalProps) {
  const attemptedAutoRepairRef = useRef("");
  const [lyricsRepairMessage, setLyricsRepairMessage] = useState("");
  const [showArtwork, setShowArtwork] = useState(true);

  const { data, loading, refetch } = useQuery<SongDetailsQueryData, SongDetailsQueryVariables>(
    SONG_DETAILS_QUERY,
    {
      variables: { id: song.id },
      fetchPolicy: "cache-and-network",
      nextFetchPolicy: "cache-first"
    }
  );

  const [repairLyrics, { loading: repairingLyrics }] = useMutation<
    LyricsRepairMutationData,
    LyricsRepairMutationVariables
  >(REPAIR_EMBEDDED_LYRICS_FOR_SONG_MUTATION);

  const details: Song = data?.songDetails ?? song;
  const lyrics = details.lyrics?.trim();

  useEffect(() => {
    setShowArtwork(true);
  }, [details.id]);

  async function extractLyricsForThisSong(manual = false) {
    if (repairingLyrics) {
      return;
    }

    setLyricsRepairMessage(manual ? "Checking this MP3 for embedded lyrics..." : "");

    try {
      const result = await repairLyrics({
        variables: { songId: details.id }
      });

      const payload = result.data?.repairEmbeddedLyricsForSong;

      if (payload?.repairedCount) {
        setLyricsRepairMessage("Lyrics were extracted. Refreshing metadata...");
        await refetch();
        return;
      }

      setLyricsRepairMessage(payload?.message || "No embedded lyrics were found for this track.");
      await refetch();
    } catch (error) {
      setLyricsRepairMessage(
        error instanceof Error
          ? `Could not extract lyrics: ${error.message}`
          : "Could not extract lyrics for this track."
      );
    }
  }

  useEffect(() => {
    const hasLyrics = Boolean(lyrics);

    if (hasLyrics || loading || repairingLyrics) {
      return;
    }

    if (attemptedAutoRepairRef.current === details.id) {
      return;
    }

    attemptedAutoRepairRef.current = details.id;
    void extractLyricsForThisSong(false);
  }, [details.id, lyrics, loading, repairingLyrics]);

  const modal = (
    <div
      className="song-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Details for ${formatSongDisplayName(details)}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="song-modal" onClick={(event) => event.stopPropagation()}>
        <div className={showArtwork ? "song-modal__body song-modal__content" : "song-modal__body song-modal__content song-modal__content--art-hidden"}>
          <h2>{details.title}</h2>
          <p className="song-modal__artist">{details.artistName}</p>

          <SongActions
            song={details}
            playlists={playlists}
            isFavorite={isFavorite}
            onPlay={() => onPlay()}
            onQueue={() => onQueue()}
            onToggleFavorite={() => onToggleFavorite()}
            onAddToPlaylist={(playlistId) => onAddToPlaylist(playlistId)}
            className="song-actions--modal"
          />

          {showArtwork ? (
            <button
              type="button"
              className="song-modal__art-button"
              onClick={() => setShowArtwork(false)}
              aria-label="Hide thumbnail and expand lyrics"
            >
              <SongArtwork
                song={details}
                wrapClassName="song-modal__hero"
                fallbackClassName="song-modal__fallback"
                loading="eager"
                eager
                disableNowPlayingStyle
              />
            </button>
          ) : null}

          <LyricSearch key={details.id} lyrics={lyrics ?? ""}
            loadingLabel={loading || repairingLyrics ? (repairingLyrics ? "Extracting lyrics..." : "Loading lyrics...") : undefined}>
              <div className="song-modal__empty-state">
                <p className="song-modal__empty">
                  {lyricsRepairMessage || "Checking this track for embedded lyrics..."}
                </p>

                <button
                  type="button"
                  className="song-modal__secondary-button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void extractLyricsForThisSong(true);
                  }}
                  disabled={repairingLyrics}
                >
                  <RefreshCw aria-hidden="true" />
                  {repairingLyrics ? "Checking..." : "Check embedded lyrics again"}
                </button>
              </div>
          </LyricSearch>

          {!showArtwork ? (
            <div className="song-modal__actions">
              <button
                type="button"
                className="song-modal__secondary-button"
                onClick={() => setShowArtwork(true)}
              >
                Show thumbnail
              </button>
            </div>
          ) : null}

        </div>

        <button
          type="button"
          className="song-modal__close"
          onClick={onClose}
          aria-label="Close modal"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
