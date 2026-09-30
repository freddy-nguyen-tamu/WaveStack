import { useLayoutEffect, useMemo, useRef } from "react";
import { X, Trash2 } from "lucide-react";
import type { ClientPlaylist, OpenSongDetailsHandler, PlaybackContext, PlaySongHandler, Song } from "../../App";
import { formatSongDisplayName } from "../../song-format";
import { SongActions } from "../../components/SongActions";
import { SongIdentityButton } from "../../components/SongIdentityButton";
import { containDialogTab } from "../../hooks/containDialogTab";
import { isPointerInput } from "../../hooks/pointerFocus";

type QueueDrawerProps = {
  open: boolean;
  queue: Song[];
  currentSongId: string | null;
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  onClose: () => void;
  onPlay: PlaySongHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onRemove: (songId: string) => void;
  onClear: () => void;
  onOpenDetails: OpenSongDetailsHandler;
};

export function QueueDrawer({
  open,
  queue,
  currentSongId,
  playlists,
  favoriteIds,
  onClose,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist,
  onRemove,
  onClear,
  onOpenDetails
}: QueueDrawerProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const queuePlaybackContext = useMemo<PlaybackContext>(() => ({
    id: "queue",
    label: "Queue",
    source: "manual",
    songs: queue
  }), [queue]);

  useLayoutEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement;
    // Capture the opener's modality before Escape changes keyboard state.
    const openedByPointer = isPointerInput();
    const backdrop = backdropRef.current;
    const drawer = drawerRef.current;

    const containBackgroundScroll = (event: WheelEvent | TouchEvent) => {
      if (drawer && event.target instanceof Node && !drawer.contains(event.target)) {
        event.preventDefault();
      }
    };

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onCloseRef.current();
      } else {
        containDialogTab(event, drawer);
      }
    }

    backdrop?.addEventListener("wheel", containBackgroundScroll, { passive: false });
    backdrop?.addEventListener("touchmove", containBackgroundScroll, { passive: false });
    window.addEventListener("keydown", handleKeyDown);
    if (openedByPointer) {
      drawer?.focus({ preventScroll: true });
    } else {
      drawer?.querySelector<HTMLButtonElement>(".queue-drawer__close")?.focus({ preventScroll: true });
    }

    return () => {
      backdrop?.removeEventListener("wheel", containBackgroundScroll);
      backdrop?.removeEventListener("touchmove", containBackgroundScroll);
      window.removeEventListener("keydown", handleKeyDown);
      // Only restore a button after a keyboard dismissal. Pointer focus
      // restoration otherwise leaves a highlighted control after closing.
      if (!document.querySelector(".song-modal-backdrop") &&
          !openedByPointer && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      } else if (drawer?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
    };
  }, [open]);

  return (
    <>
      {open ? (
        <div
          ref={backdropRef}
          className="queue-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              onClose();
            }
          }}
        >
          <aside
            ref={drawerRef}
            className="queue-drawer"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-label="Play queue"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="queue-drawer__header">
              <h2>Queue ({queue.length})</h2>
              <button
                type="button"
                className="queue-drawer__close"
                onClick={onClose}
                aria-label="Close queue"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="queue-drawer__actions">
              <button
                type="button"
                onClick={onClear}
                disabled={!queue.length}
              >
                Clear queue
              </button>
            </div>

            <div className="queue-drawer__list">
              {queue.length === 0 ? (
                <p className="queue-drawer__empty">Queue is empty.</p>
              ) : (
                queue.map((song) => {
                  const isCurrent = song.id === currentSongId;

                  return (
                    <div
                      key={song.id}
                      className={`queue-drawer__item${isCurrent ? " queue-drawer__item--current" : ""}`}
                    >
                      <SongIdentityButton
                        song={song}
                        subtitle={isCurrent ? `Now playing · ${song.artistName}` : song.artistName}
                        className="song-identity-button queue-drawer__identity"
                        artClassName="song-list-row__art queue-drawer__art"
                        fallbackClassName="song-list-row__art-fallback"
                        imageClassName="song-list-row__art-image"
                        playbackContext={queuePlaybackContext}
                        onOpenDetails={onOpenDetails}
                      />
                      <div className="queue-drawer__body">

                        <SongActions
                          song={song}
                          playlists={playlists}
                          isFavorite={favoriteIds.includes(song.id)}
                          playbackContext={queuePlaybackContext}
                          onPlay={onPlay}
                          onQueue={onQueue}
                          onToggleFavorite={onToggleFavorite}
                          onAddToPlaylist={onAddToPlaylist}
                          className="song-actions--queue"
                        />
                      </div>

                      <button
                        type="button"
                        className="queue-drawer__remove"
                        onClick={() => onRemove(song.id)}
                        aria-label={`Remove ${formatSongDisplayName(song)}`}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
