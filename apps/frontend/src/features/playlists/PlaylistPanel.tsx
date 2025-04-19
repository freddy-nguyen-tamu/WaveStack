import { ListPlus, Play } from "lucide-react";
import type { Song } from "../../App";

type Playlist = {
  id: string;
  name: string;
  songCount: number;
};

type PlaylistPanelProps = {
  songs: Song[];
  playlists: Playlist[];
  onPlay: (song: Song) => void;
};

export function PlaylistPanel({ songs, playlists, onPlay }: PlaylistPanelProps) {
  return (
    <article>
      <h2>Playlists</h2>
      <button type="button">
        <ListPlus aria-hidden="true" /> New playlist
      </button>
      <ul>
        {playlists.map((playlist) => (
          <li key={playlist.id}>
            {playlist.name} ({playlist.songCount})
          </li>
        ))}
      </ul>
      <h3>Library</h3>
      <ul>
        {songs.map((song) => (
          <li key={song.id}>
            <button type="button" onClick={() => onPlay(song)} aria-label={`Play ${song.title}`}>
              <Play aria-hidden="true" />
            </button>
            {song.title} - {song.artistName}
          </li>
        ))}
      </ul>
    </article>
  );
}
