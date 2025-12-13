import { createPortal } from "react-dom";
import { Play, X } from "lucide-react";
import { useQuery } from "@apollo/client";
import type { Song } from "../../App";
import { SONG_DETAILS_QUERY } from "../../api";
import { formatBytes, formatSeconds, formatSongDisplayName } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";

type SongMetadataModalProps = {
  song: Song;
  onPlay: () => void;
  onClose: () => void;
};

type SongDetailsQueryData = {
  songDetails: Song | null;
};

type SongDetailsQueryVariables = {
  id: string;
};

export function SongMetadataModal({ song, onPlay, onClose }: SongMetadataModalProps) {
  const { data, loading } = useQuery<SongDetailsQueryData, SongDetailsQueryVariables>(
    SONG_DETAILS_QUERY,
    {
      variables: { id: song.id },
      fetchPolicy: "cache-and-network",
      nextFetchPolicy: "cache-first"
    }
  );

  const details: Song = data?.songDetails ?? song;
  const genreNames: string[] = details.genreNames ?? [];
  const lyrics = details.lyrics?.trim();

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
        <SongArtwork
          song={details}
          wrapClassName="song-modal__hero"
          fallbackClassName="song-modal__fallback"
          loading="eager"
          eager
        />

        <div className="song-modal__body">
          <button
            className="song-modal__play-button"
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPlay();
            }}
          >
            <Play aria-hidden="true" /> Play without closing
          </button>

          <h2>{details.title}</h2>
          <p className="song-modal__artist">{details.artistName}</p>

          {details.albumTitle ? (
            <p className="song-modal__album">{details.albumTitle}</p>
          ) : null}

          {genreNames.length ? (
            <div className="song-modal__genres">
              {genreNames.map((genre) => (
                <span key={genre} className="song-modal__genre-tag">
                  {genre}
                </span>
              ))}
            </div>
          ) : null}

          <section className="song-modal__lyrics-panel" aria-label="Lyrics">
            <div className="song-modal__section-heading">
              <h3>Lyrics</h3>
              {loading ? <span>Refreshing metadata...</span> : null}
            </div>

            {lyrics ? (
              <pre className="song-modal__lyrics-text">{lyrics}</pre>
            ) : (
              <p className="song-modal__empty">
                No embedded lyrics have been extracted for this song yet. Run
                <code> repairEmbeddedLyrics </code>
                and reopen this modal.
              </p>
            )}
          </section>

          <section aria-label="All metadata">
            <h3>All metadata</h3>

            <table className="song-modal__table">
              <tbody>
                <tr>
                  <td>Display name</td>
                  <td>{formatSongDisplayName(details)}</td>
                </tr>

                <tr>
                  <td>Title</td>
                  <td>{details.title}</td>
                </tr>

                <tr>
                  <td>Artist / author</td>
                  <td>{details.artistName}</td>
                </tr>

                <tr>
                  <td>Album / source</td>
                  <td>{details.albumTitle || "Unknown"}</td>
                </tr>

                <tr>
                  <td>Duration</td>
                  <td>{formatSeconds(details.durationSeconds)} ({details.durationSeconds || 0} seconds)</td>
                </tr>

                <tr>
                  <td>Lyrics attribute</td>
                  <td>{lyrics ? `${lyrics.length.toLocaleString()} characters` : "Not extracted yet"}</td>
                </tr>

                {details.webViewLink ? (
                  <tr>
                    <td>Drive link</td>
                    <td>
                      <a href={details.webViewLink} target="_blank" rel="noreferrer">
                        Open in Google Drive
                      </a>
                    </td>
                  </tr>
                ) : null}

                <tr>
                  <td>MIME type</td>
                  <td>{details.mimeType || "Unknown"}</td>
                </tr>

                <tr>
                  <td>Modified</td>
                  <td>{details.modifiedTime || "Unknown"}</td>
                </tr>

                <tr>
                  <td>Size</td>
                  <td>{formatBytes(details.sizeBytes)}</td>
                </tr>

                <tr>
                  <td>Source folder</td>
                  <td>{details.sourceRootFolderId || "Unknown"}</td>
                </tr>

                <tr>
                  <td>Stream URL</td>
                  <td>{details.streamUrl}</td>
                </tr>
              </tbody>
            </table>
          </section>
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
