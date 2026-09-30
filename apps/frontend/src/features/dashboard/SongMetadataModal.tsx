import { createPortal } from "react-dom";
import { LyricSearch } from "./LyricSearch";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { containDialogTab } from "../../hooks/containDialogTab";

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
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const previousFocus = document.activeElement;
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    const applicationRoot = document.getElementById("root");
    const wasInert = applicationRoot?.inert ?? false;

    // The portal lives outside #root, so the background can become inert
    // without disabling the dialog itself or changing page overflow.
    if (applicationRoot) applicationRoot.inert = true;

    // Keep the document's scrolling element intact. Repeatedly toggling body
    // overflow while Chromium is dispatching a wheel gesture can leave that
    // gesture latched to the disappearing modal until the pointer moves.
    const containBackgroundScroll = (event: WheelEvent | TouchEvent) => {
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        event.preventDefault();
      }
    };

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onCloseRef.current();
      } else {
        containDialogTab(event, dialog);
      }
    };

    backdrop?.addEventListener("wheel", containBackgroundScroll, { passive: false });
    backdrop?.addEventListener("touchmove", containBackgroundScroll, { passive: false });
    window.addEventListener("keydown", handleDialogKeyDown);
    closeButtonRef.current?.focus({ preventScroll: true });

    return () => {
      backdrop?.removeEventListener("wheel", containBackgroundScroll);
      backdrop?.removeEventListener("touchmove", containBackgroundScroll);
      window.removeEventListener("keydown", handleDialogKeyDown);
      if (applicationRoot) applicationRoot.inert = wasInert;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const { data, loading, refetch } = useQuery<SongDetailsQueryData, SongDetailsQueryVariables>(
    SONG_DETAILS_QUERY,
    {
      variables: { id: song.id },
      // Cached details open immediately; manual lyric repair still calls refetch.
      // Reissuing the full metadata query on every modal opening generated
      // duplicate loading/paint cycles even when nothing had changed.
      fetchPolicy: "cache-first"
    }
  );

  const [repairLyrics, { loading: repairingLyrics }] = useMutation<
    LyricsRepairMutationData,
    LyricsRepairMutationVariables
  >(REPAIR_EMBEDDED_LYRICS_FOR_SONG_MUTATION);

  const details: Song = data?.songDetails ?? song;
  const lyrics = details.lyrics?.trim();

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
      ref={backdropRef}
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
      <div ref={dialogRef} className="song-modal" onClick={(event) => event.stopPropagation()}>
        <div className="song-modal__body song-modal__content">
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

          <SongArtwork
            song={details}
            wrapClassName="song-modal__hero"
            fallbackClassName="song-modal__fallback"
            loading="eager"
            eager
            disableNowPlayingStyle
          />

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

        </div>

        <button
          ref={closeButtonRef}
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
