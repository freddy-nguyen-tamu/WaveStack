import { Activity, Heart, TrendingUp } from "lucide-react";
import type { Song } from "../../App";

type DashboardProps = {
  loading: boolean;
  recentlyPlayed: Song[];
  recommendations: Song[];
};

export function Dashboard({ loading, recentlyPlayed, recommendations }: DashboardProps) {
  return (
    <article>
      <h2>Dashboard</h2>
      {loading ? <p>Loading music data...</p> : null}
      <section aria-label="Recently played">
        <h3>
          <Activity aria-hidden="true" /> Recently played
        </h3>
        <ol>
          {recentlyPlayed.map((song) => (
            <li key={song.id}>{song.title}</li>
          ))}
        </ol>
      </section>
      <section aria-label="Favorite songs">
        <h3>
          <Heart aria-hidden="true" /> Favorites
        </h3>
        <p>Favorite songs are persisted through the GraphQL API and PostgreSQL.</p>
      </section>
      <section aria-label="Recommendations">
        <h3>
          <TrendingUp aria-hidden="true" /> Recommendations
        </h3>
        <ol>
          {recommendations.map((song) => (
            <li key={song.id}>
              {song.title} {song.score ? `(${song.score})` : ""}
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
