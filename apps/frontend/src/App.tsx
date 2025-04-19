import { useMemo, useState } from "react";
import { useQuery } from "@apollo/client";
import { Library, Search, Heart, Clock, ListMusic } from "lucide-react";
import { MUSIC_HOME_QUERY } from "./api";
import { Player } from "./features/player/Player";
import { PlaylistPanel } from "./features/playlists/PlaylistPanel";
import { SearchPanel } from "./features/search/SearchPanel";
import { Dashboard } from "./features/dashboard/Dashboard";

export type Song = {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  durationSeconds: number;
  streamUrl: string;
  genreNames: string[];
  score?: number;
};

const fallbackSongs: Song[] = [
  {
    id: "demo-1",
    title: "Cloudline",
    artistName: "The Latency",
    albumTitle: "Regions",
    durationSeconds: 213,
    streamUrl: "/demo/cloudline.mp3",
    genreNames: ["electronic", "ambient"]
  },
  {
    id: "demo-2",
    title: "Packet Chorus",
    artistName: "Blue Queue",
    albumTitle: "Async Hearts",
    durationSeconds: 188,
    streamUrl: "/demo/packet-chorus.mp3",
    genreNames: ["indie", "pop"]
  }
];

export function App() {
  const [activeSong, setActiveSong] = useState<Song>(fallbackSongs[0]);
  const [queue, setQueue] = useState<Song[]>(fallbackSongs);
  const { data, loading } = useQuery(MUSIC_HOME_QUERY);

  const songs = useMemo<Song[]>(() => data?.songs?.length ? data.songs : fallbackSongs, [data]);
  const recentlyPlayed = data?.recentlyPlayed ?? fallbackSongs.slice(0, 1);
  const recommendations = data?.recommendations ?? fallbackSongs;

  return (
    <main>
      <header>
        <h1>WaveStack</h1>
        <p>Cloud-native music streaming platform</p>
        <nav aria-label="Primary">
          <button type="button">
            <Library aria-hidden="true" /> Library
          </button>
          <button type="button">
            <Search aria-hidden="true" /> Search
          </button>
          <button type="button">
            <Heart aria-hidden="true" /> Favorites
          </button>
          <button type="button">
            <Clock aria-hidden="true" /> Recent
          </button>
          <button type="button">
            <ListMusic aria-hidden="true" /> Queue
          </button>
        </nav>
      </header>

      <section aria-label="Player">
        <Player activeSong={activeSong} queue={queue} onQueueChange={setQueue} />
      </section>

      <section aria-label="Dashboard">
        <Dashboard loading={loading} recentlyPlayed={recentlyPlayed} recommendations={recommendations} />
      </section>

      <section aria-label="Search and playlists">
        <SearchPanel songs={songs} onPlay={setActiveSong} onQueue={(song) => setQueue((items) => [...items, song])} />
        <PlaylistPanel songs={songs} playlists={data?.playlists ?? []} onPlay={setActiveSong} />
      </section>
    </main>
  );
}
