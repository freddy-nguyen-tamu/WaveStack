import { Activity, Heart, Play, TrendingUp } from "lucide-react";
import type { Song } from "../../App";

type DashboardProps = {
  loading: boolean;
  songs: Song[];
  favorites: Song[];
  recentlyPlayed: Song[];
  onPlay: (song: Song) => void;
};

export function Dashboard({ loading, songs, favorites, recentlyPlayed, onPlay }: DashboardProps) {
  const recommendations = songs.slice(0, 5);

  return (
    <article>
      <h2>Dashboard</h2>
      {loading ? <p>Loading music data...</p> : null}

      <section aria-label="Library summary">
        <h3>
          <TrendingUp aria-hidden="true" /> Library summary
        </h3>
        <p>Total songs loaded: {songs.length}</p>
        <p>Favorites: {favorites.length}</p>
        <p>Recently played: {recentlyPlayed.length}</p>
      </section>

      <section aria-label="Recently played">
        <h3>
          <Activity aria-hidden="true" /> Recently played
        </h3>
        {recentlyPlayed.length ? (
          <ol>
            {recentlyPlayed.slice(0, 5).map((song) => (
              <li key={song.id}>
                <button type="button" onClick={() => onPlay(song)}>
                  <Play aria-hidden="true" /> Play
                </button>
                {song.title}
              </li>
            ))}
          </ol>
        ) : (
          <p>No recently played songs yet.</p>
        )}
      </section>

      <section aria-label="Favorite songs">
        <h3>
          <Heart aria-hidden="true" /> Favorites
        </h3>
        {favorites.length ? (
          <ol>
            {favorites.slice(0, 5).map((song) => (
              <li key={song.id}>
                <button type="button" onClick={() => onPlay(song)}>
                  <Play aria-hidden="true" /> Play
                </button>
                {song.title}
              </li>
            ))}
          </ol>
        ) : (
          <p>No favorites yet.</p>
        )}
      </section>

      <section aria-label="Recommendations">
        <h3>
          <TrendingUp aria-hidden="true" /> Recommendations
        </h3>
        {recommendations.length ? (
          <ol>
            {recommendations.map((song) => (
              <li key={song.id}>
                <button type="button" onClick={() => onPlay(song)}>
                  <Play aria-hidden="true" /> Play
                </button>
                {song.title}
              </li>
            ))}
          </ol>
        ) : (
          <p>No recommendations available.</p>
        )}
      </section>
    </article>
  );
}
