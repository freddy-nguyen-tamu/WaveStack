import { X } from "lucide-react";
import { useEffect } from "react";
import type { Song } from "../../App";
import { formatBytes, formatSeconds, formatSongDisplayName, hasThumbnail } from "../../song-format";

type SongMetadataModalProps = {
  song: Song | null;
  onClose: () => void;
  onPlay: (song: Song) => void;
};

export function SongMetadataModal({ song, onClose, onPlay }: SongMetadataModalProps) {
  useEffect(() => {
    if (!song) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.body.classList.add("modal-open");

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("modal-open");
    };
  }, [song, onClose]);

  if (!song) {
    return null;
  }

  const allMetadata: Array<[string, string]> = [
    ["ID", song.id],
    ["Title", song.title],
    ["Artist / author", song.artistName],
    ["Album", song.albumTitle],
    ["Duration", formatSeconds(song.durationSeconds)],
    ["Genres", song.genreNames.join(", ") || "None"],
    ["Score", song.score === undefined ? "None" : String(song.score)],
    ["Thumbnail URL", song.thumbnailUrl || "None"],
    ["Stream URL", song.streamUrl],
    ["Google Drive page", song.webViewLink || "None"],
    ["MIME type", song.mimeType || "Unknown"],
    ["Modified time", song.modifiedTime || "Unknown"],
    ["Size", formatBytes(song.sizeBytes)],
    ["Source root folder", song.sourceRootFolderId || "Unknown"]
  ];

  return (
    <div className="song-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="song-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="song-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="song-modal__close" type="button" onClick={onClose} aria-label="Close song details">
          <X aria-hidden="true" />
        </button>

        <div className="song-modal__hero">
          {hasThumbnail(song) ? (
            <img src={song.thumbnailUrl} alt="" />
          ) : (
            <div className="song-modal__fallback" aria-hidden="true">
              {song.artistName?.trim()?.charAt(0)?.toUpperCase() || "\u266A"}
            </div>
          )}
        </div>

        <div className="song-modal__content">
          <p className="eyebrow">Song metadata</p>
          <h2 id="song-modal-title">{song.title}</h2>
          <h3>{song.artistName}</h3>

          <section className="song-modal__lyrics" aria-label="Lyrics">
            <h4>Lyrics</h4>
            <p>{song.lyrics?.trim() || "No lyrics attribute is available for this song yet."}</p>
          </section>

          <button type="button" onClick={() => onPlay(song)}>
            Play {formatSongDisplayName(song)}
          </button>

          <section aria-label="All metadata">
            <h4>All metadata</h4>
            <dl className="metadata-grid">
              {allMetadata.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </section>
    </div>
  );
}
