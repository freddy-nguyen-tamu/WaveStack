import { useEffect } from "react";
import { X, Trash2, Play } from "lucide-react";
import type { Song } from "../../App";
import { formatSongDisplayName } from "../../song-format";

type QueueDrawerProps = {
  open: boolean;
  queue: Song[];
  currentSongId: string | null;
  onClose: () => void;
  onPlay: (song: Song) => void;
  onRemove: (songId: string) => void;
  onClear: () => void;
};

export function QueueDrawer({
  open,
  queue,
  currentSongId,
  onClose,
  onPlay,
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
                      <button
                        type="button"
                        className="queue-drawer__play"
                        onClick={() => onPlay(song)}
                        aria-label={`Play ${formatSongDisplayName(song)}`}
                      >
                        {isCurrent ? <Play aria-hidden="true" fill="currentColor" /> : <Play aria-hidden="true" />}
                      </button>

                      <span className="queue-drawer__name">
                        {isCurrent ? <strong>Now: </strong> : null}
                        {formatSongDisplayName(song)}
                      </span>

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
