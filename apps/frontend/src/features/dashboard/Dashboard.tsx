import { Activity, Heart, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Song } from "../../App";
import { formatSeconds, getSongCardSize, getWeightedSongLength } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";
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
      const aDuration = getWeightedSongLength(a);
      const bDuration = getWeightedSongLength(b);
      const aScore = (a.score ?? 0) * 1000 + aDuration * 0.5;
      const bScore = (b.score ?? 0) * 1000 + bDuration * 0.5;

      return bScore - aScore;
    });
  }, [songs]);

  useEffect(() => {
    if (!selectedSong) {
      document.body.classList.remove("modal-open");
      return;
    }

    document.body.classList.add("modal-open");

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedSong(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedSong]);

  return (
    <article className="dashboard-page">
      <div className="dashboard-page__header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h2>Suggested songs</h2>
          <p>
            A visual recommendation wall. Real Drive songs are sized by their
            duration, with file size used as a fallback when Drive does not
            expose exact audio duration.
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
              <article className={`song-tile song-tile--${size}`} key={song.id}>
                <button
                  className="song-tile__open"
                  type="button"
                  onClick={() => setSelectedSong(song)}
                  aria-label={`Open metadata for ${song.artistName} - ${song.title}`}
                >
                  <SongArtwork
                    song={song}
                    wrapClassName="song-tile__media"
                    fallbackClassName="song-tile__fallback"
                  />

                  <span className="song-tile__overlay">
                    <span>
                      <strong>{song.title}</strong>
                      <small>{song.artistName}</small>
                    </span>
                    <span className="song-tile__duration">{formatSeconds(song.durationSeconds)}</span>
                  </span>
                </button>

                <button
                  className="song-tile__play"
                  type="button"
                  onClick={() => onPlay(song)}
                  aria-label={`Play ${song.artistName} - ${song.title}`}
                >
                  Play
                </button>
              </article>
            );
          })}
        </section>
      ) : (
        <p>No song suggestions available.</p>
      )}

      {selectedSong ? (
        <SongMetadataModal song={selectedSong} onClose={() => setSelectedSong(null)} />
      ) : null}
    </article>
  );
}
