import { useEffect } from "react";
import { X, Trash2 } from "lucide-react";
import type { ClientPlaylist, Song } from "../../App";
import { formatSongDisplayName } from "../../song-format";
import { SongActions } from "../../components/SongActions";
import { SongArtwork } from "../../components/SongArtwork";

type QueueDrawerProps = {
  open: boolean;
  queue: Song[];
  currentSongId: string | null;
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  onClose: () => void;
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onRemove: (songId: string) => void;
  onClear: () => void;
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
  onClear
}: QueueDrawerProps) {
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  return (
    <>
      {open ? (
        <div
          className="queue-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              onClose();
            }
          }}
        >
          <aside
            className="queue-drawer"
            role="dialog"
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
                      <SongArtwork
                        song={song}
                        wrapClassName="song-list-row__art queue-drawer__art"
                        fallbackClassName="song-list-row__art-fallback"
                        imageClassName="song-list-row__art-image"
                      />
                      <div className="queue-drawer__body">
                        <span className="queue-drawer__name">
                          {isCurrent ? <strong>Now: </strong> : null}
                          {formatSongDisplayName(song)}
                        </span>

                        <SongActions
                          song={song}
                          playlists={playlists}
                          isFavorite={favoriteIds.includes(song.id)}
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
