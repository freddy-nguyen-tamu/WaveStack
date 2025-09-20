import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Song } from "../../App";
import { formatBytes, formatSeconds, formatSongDisplayName, hasThumbnail } from "../../song-format";

type SongMetadataModalProps = {
  song: Song;
  onClose: () => void;
};

export function SongMetadataModal({ song, onClose }: SongMetadataModalProps) {
  const modal = (
    <div
      className="song-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="song-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="song-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="song-modal__close" type="button" onClick={onClose} aria-label="Close song metadata">
          <X aria-hidden="true" />
        </button>

        <div className="song-modal__hero" aria-hidden="true">
          {hasThumbnail(song) ? (
            <img src={song.thumbnailUrl} alt="" />
          ) : (
            <div className="song-modal__fallback">
              {song.artistName?.trim()?.charAt(0)?.toUpperCase() || "\u266A"}
            </div>
          )}
        </div>

        <div className="song-modal__content">
          <div>
            <p className="eyebrow">Song metadata</p>
            <h2 id="song-modal-title">{song.title}</h2>
            <h3>{song.artistName}</h3>
          </div>

          <section className="song-modal__lyrics" aria-label="Lyrics">
            <h4>Lyrics</h4>
            <p>{song.lyrics?.trim() || "No lyrics attribute was provided for this Drive file."}</p>
          </section>

          <dl className="metadata-grid">
            <div>
              <dt>Display name</dt>
              <dd>{formatSongDisplayName(song)}</dd>
            </div>
            <div>
              <dt>Title</dt>
              <dd>{song.title}</dd>
            </div>
            <div>
              <dt>Artist / author</dt>
              <dd>{song.artistName}</dd>
            </div>
            <div>
              <dt>Album / source</dt>
              <dd>{song.albumTitle}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatSeconds(song.durationSeconds)} ({song.durationSeconds || 0} seconds)</dd>
            </div>
            <div>
              <dt>Genres</dt>
              <dd>{song.genreNames.length ? song.genreNames.join(", ") : "None"}</dd>
            </div>
            <div>
              <dt>Thumbnail URL</dt>
              <dd>{song.thumbnailUrl || "None"}</dd>
            </div>
            <div>
              <dt>File size</dt>
              <dd>{formatBytes(song.sizeBytes)}</dd>
            </div>
            <div>
              <dt>MIME type</dt>
              <dd>{song.mimeType || "Unknown"}</dd>
            </div>
            <div>
              <dt>Modified</dt>
              <dd>{song.modifiedTime || "Unknown"}</dd>
            </div>
            <div>
              <dt>Source folder</dt>
              <dd>{song.sourceRootFolderId || "Unknown"}</dd>
            </div>
            <div>
              <dt>Stream URL</dt>
              <dd>{song.streamUrl}</dd>
            </div>
            <div>
              <dt>Drive link</dt>
              <dd>
                {song.webViewLink ? (
                  <a href={song.webViewLink} target="_blank" rel="noreferrer">
                    Open in Google Drive
                  </a>
                ) : (
                  "None"
                )}
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}
