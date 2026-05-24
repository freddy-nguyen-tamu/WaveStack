import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Play, RefreshCw, X } from "lucide-react";
import { useMutation, useQuery } from "@apollo/client";
import type { Song } from "../../App";
import {
  REPAIR_EMBEDDED_LYRICS_FOR_SONG_MUTATION,
  SONG_DETAILS_QUERY
} from "../../api";
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

export function SongMetadataModal({ song, onPlay, onClose }: SongMetadataModalProps) {
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
  const genreNames: string[] = details.genreNames ?? [];
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
              />
            </button>
          ) : null}

          <section className="song-modal__lyrics-panel" aria-label="Lyrics">
            <div className="song-modal__section-heading">
              <div>
                <p className="eyebrow">Embedded MP3 metadata</p>
                <h3>Lyrics</h3>
              </div>

              {loading || repairingLyrics ? (
                <span>{repairingLyrics ? "Extracting lyrics..." : "Refreshing metadata..."}</span>
              ) : null}
            </div>

            {lyrics ? (
              <pre className="song-modal__lyrics-text">{lyrics}</pre>
            ) : (
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
            )}
          </section>

          <div className="song-modal__actions">
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

            {!showArtwork ? (
              <button
                type="button"
                className="song-modal__secondary-button"
                onClick={() => setShowArtwork(true)}
              >
                Show thumbnail
              </button>
            ) : null}
          </div>

          <details className="song-modal__metadata" aria-label="All metadata">
            <summary>All metadata</summary>

            {details.albumTitle || genreNames.length ? (
              <div className="song-modal__metadata-summary">
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
              </div>
            ) : null}

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
                  <td>{lyrics ? `${lyrics.length.toLocaleString()} characters` : "No embedded lyrics found yet"}</td>
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
          </details>
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
