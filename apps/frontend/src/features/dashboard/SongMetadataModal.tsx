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

export function SongMetadataModal({ song, onPlay, onClose }: SongMetadataModalProps) {
  const { data } = useQuery(SONG_DETAILS_QUERY, {
    variables: { id: song.id },
    fetchPolicy: "cache-first"
  });

  const details = data?.songDetails ?? song;

  const modal = (
    <div
      className="song-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Details for ${formatSongDisplayName(song)}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="song-modal">
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
              event.stopPropagation();
              onPlay();
            }}
          >
            <Play aria-hidden="true" /> Play
          </button>

          <h2>{details.title}</h2>
          <p className="song-modal__artist">{details.artistName}</p>

          {details.albumTitle ? (
            <p className="song-modal__album">{details.albumTitle}</p>
          ) : null}

          <div className="song-modal__genres">
            {details.genreNames?.map((genre) => (
              <span key={genre} className="song-modal__genre-tag">
                {genre}
              </span>
            ))}
          </div>

          <table className="song-modal__table">
            <tbody>
              {details.durationSeconds ? (
                <tr>
                  <td>Duration</td>
                  <td>{formatSeconds(details.durationSeconds)}</td>
                </tr>
              ) : null}

              {details.lyrics ? (
                <tr>
                  <td>Lyrics</td>
                  <td className="song-modal__lyrics">{details.lyrics}</td>
                </tr>
              ) : null}

              {details.webViewLink ? (
                <tr>
                  <td>Drive link</td>
                  <td>
                    <a href={details.webViewLink} target="_blank" rel="noreferrer">
                      Open in Drive
                    </a>
                  </td>
                </tr>
              ) : null}

              {details.mimeType ? (
                <tr>
                  <td>Format</td>
                  <td>{details.mimeType}</td>
                </tr>
              ) : null}

              {details.modifiedTime ? (
                <tr>
                  <td>Modified</td>
                  <td>{new Date(details.modifiedTime).toLocaleDateString()}</td>
                </tr>
              ) : null}

              {details.sizeBytes ? (
                <tr>
                  <td>Size</td>
                  <td>{formatBytes(details.sizeBytes)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
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
