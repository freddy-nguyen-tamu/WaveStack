import { Search, ListPlus } from "lucide-react";
import { useMemo, useState } from "react";
import type { Song } from "../../App";

type SearchPanelProps = {
  songs: Song[];
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
};

export function SearchPanel({ songs, onPlay, onQueue }: SearchPanelProps) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return songs;

    return songs.filter((song) => {
      const haystack = [
        song.title,
        song.artistName,
        song.albumTitle,
        ...song.genreNames
      ].join(" ").toLowerCase();

      return haystack.includes(needle);
    });
  }, [query, songs]);

  return (
    <article>
      <h2>Search</h2>
      <label>
        <Search aria-hidden="true" /> Song, artist, album, or genre
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ul>
        {results.map((song) => (
          <li key={song.id}>
            <button type="button" onClick={() => onPlay(song)}>
              Play
            </button>
            <button type="button" onClick={() => onQueue(song)} aria-label={`Queue ${song.title}`}>
              <ListPlus aria-hidden="true" />
            </button>
            {song.title} - {song.artistName} - {song.albumTitle}
          </li>
        ))}
      </ul>
    </article>
  );
}
