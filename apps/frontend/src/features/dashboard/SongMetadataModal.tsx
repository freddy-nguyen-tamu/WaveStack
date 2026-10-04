
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
import { cancelWheelHandoff, handOffWheelToDocument } from "../../hooks/wheelHandoff";

type SongMetadataModalProps = {
  open: boolean;
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
  open,
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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const closeDialog = () => {
    if (!open) return;
    // Install the handoff before removing focus or changing the scroll target.
    handOffWheelToDocument();
    onCloseRef.current();
  };
  const closeDialogRef = useRef(closeDialog);
  closeDialogRef.current = closeDialog;

  useLayoutEffect(() => {
    if (!open) return;
    cancelWheelHandoff();
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    // Keep the page scroll container and application root unchanged. A fixed
    // overlay and Tab containment provide modal input isolation without inert
    // toggling the scroll-tree target in the middle of a wheel gesture.
    const containBackgroundScroll = (event: WheelEvent | TouchEvent) => {
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        event.preventDefault();
      }
    };

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeDialogRef.current();
      } else if (event.key === "Tab") {
        // WaveStack intentionally has no persistent non-editor focus owner.
        // Keep Tab from manufacturing one inside the modal. Text inputs still
        // own focus while actively editing/searching.
        event.preventDefault();
      }
    };

    backdrop?.addEventListener("wheel", containBackgroundScroll, { passive: false });
    backdrop?.addEventListener("touchmove", containBackgroundScroll, { passive: false });
    window.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      backdrop?.removeEventListener("wheel", containBackgroundScroll);
      backdrop?.removeEventListener("touchmove", containBackgroundScroll);
      window.removeEventListener("keydown", handleDialogKeyDown);
      if (backdrop?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
    };
  }, [open]);

  const { data, loading, refetch } = useQuery<SongDetailsQueryData, SongDetailsQueryVariables>(
    SONG_DETAILS_QUERY,
    {
      variables: { id: song.id },
      // Cached details open immediately; manual lyric repair still calls refetch.
      // Reissuing the full metadata query on every modal opening generated
      // duplicate loading/paint cycles even when nothing had changed.
      fetchPolicy: "cache-first",
      skip: !open
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

      // If the database already had lyrics while the cached details query was
      // stale, refresh once. A confirmed no-lyrics result needs no second round trip.
      if (/already has lyrics/i.test(payload?.message ?? "")) {
        await refetch();
      }
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

    if (!open || hasLyrics || loading || repairingLyrics) {
      return;
    }

    if (attemptedAutoRepairRef.current === details.id) {
      return;
    }

    attemptedAutoRepairRef.current = details.id;
    void extractLyricsForThisSong(false);
  }, [open, details.id, lyrics, loading, repairingLyrics]);

  const modal = (
    <div
      ref={backdropRef}
      className={`song-modal-backdrop${open ? "" : " song-modal-backdrop--released"}`}
      role={open ? "dialog" : undefined}
      aria-modal={open ? "true" : undefined}
      aria-hidden={open ? undefined : true}
      aria-label={`Details for ${formatSongDisplayName(details)}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
        }
      }}
    >
      <div ref={dialogRef} className="song-modal" onClick={(event) => event.stopPropagation()}>
        {open ? (<>
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
            loadingLabel={!lyrics && (loading || repairingLyrics) ? (repairingLyrics ? "Extracting lyrics..." : "Loading lyrics...") : undefined}>
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
          type="button"
          className="song-modal__close"
          onClick={closeDialog}
          aria-label="Close modal"
        >
          <X aria-hidden="true" />
        </button>
        </>) : <div aria-hidden="true" className="song-modal__released-spacer" />}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
