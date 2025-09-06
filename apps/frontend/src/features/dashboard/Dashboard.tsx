import { Activity, Heart, Play, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import type { Song } from "../../App";
import { formatSeconds, formatSongDisplayName, getSongCardSize, hasThumbnail } from "../../song-format";
import { SongMetadataModal } from "./SongMetadataModal";

type DashboardProps = {
  loading: boolean;
  songs: Song[];
  favorites: Song[];
  recentlyPlayed: Song[];
  onPlay: (song: Song) => void;
};

export function Dashboard({ loading, songs, favorites, recentlyPlayed, onPlay }: DashboardProps) {
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);

  const suggestions = useMemo(() => {
    return [...songs].sort((a, b) => {
      const aScore = (a.score ?? 0) + (a.durationSeconds ?? 0) / 1000;
      const bScore = (b.score ?? 0) + (b.durationSeconds ?? 0) / 1000;
      return bScore - aScore;
    });
  }, [songs]);

  return (
    <article className="dashboard-page">
      <div className="dashboard-page__header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h2>Suggested songs</h2>
          <p>
            A visual recommendation wall. Longer songs appear larger, and every
            card opens full metadata.
          </p>
        </div>

        {loading ? <p>Loading music data...</p> : null}
      </div>

      <section className="dashboard-stats" aria-label="Library summary">
        <div>
          <TrendingUp aria-hidden="true" />
          <strong>{songs.length}</strong>
          <span>Total songs</span>
        </div>
        <div>
          <Heart aria-hidden="true" />
          <strong>{favorites.length}</strong>
          <span>Favorites</span>
        </div>
        <div>
          <Activity aria-hidden="true" />
          <strong>{recentlyPlayed.length}</strong>
          <span>Recently played</span>
        </div>
      </section>

      {suggestions.length ? (
        <section className="song-masonry" aria-label="Suggested songs">
          {suggestions.map((song, index) => {
            const size = getSongCardSize(song, index);

            return (
              <button
                className={`song-tile song-tile--${size}`}
                type="button"
                key={song.id}
                onClick={() => setSelectedSong(song)}
                aria-label={`Open metadata for ${formatSongDisplayName(song)}`}
              >
                <span className="song-tile__media">
                  {hasThumbnail(song) ? (
                    <img src={song.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="song-tile__fallback" aria-hidden="true">
                      {song.artistName?.trim()?.charAt(0)?.toUpperCase() || "\u266A"}
                    </span>
                  )}
                </span>

                <span className="song-tile__overlay">
                  <span>
                    <strong>{song.title}</strong>
                    <small>{song.artistName}</small>
                  </span>
                  <span className="song-tile__duration">{formatSeconds(song.durationSeconds)}</span>
                </span>

                <span
                  className="song-tile__quick-play"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlay(song);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onPlay(song);
                    }
                  }}
                  aria-label={`Play ${formatSongDisplayName(song)}`}
                >
                  <Play aria-hidden="true" />
                </span>
              </button>
            );
          })}
        </section>
      ) : (
        <p>No song suggestions are available yet.</p>
      )}

      <SongMetadataModal
        song={selectedSong}
        onClose={() => setSelectedSong(null)}
        onPlay={onPlay}
      />
    </article>
  );
}
