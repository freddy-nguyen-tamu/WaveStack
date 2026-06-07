import type { Song } from "../../App";
import { formatSeconds } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";
import { SongActions } from "../../components/SongActions";
import type { ClientPlaylist } from "../../App";

type AllPageProps = {
  songs: Song[];
  localTracks: Song[];
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
};

export function AllPage({
  songs,
  localTracks,
  playlists,
  favoriteIds,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist
}: AllPageProps) {
  const allSongs = [...localTracks, ...songs];

  if (!allSongs.length) {
    return (
      <article className="all-page">
        <p className="eyebrow">Library</p>
        <h2>All Songs</h2>
        <p>No songs found. Upload your first track or sign in to load your library.</p>
      </article>
    );
  }

  return (
    <article className="all-page">
      <p className="eyebrow">Library</p>
      <h2>All Songs ({allSongs.length})</h2>

      {localTracks.length > 0 && (
        <section className="all-page__section" aria-label="Local uploads">
          <h3>Local Uploads ({localTracks.length})</h3>
          <div className="all-page__grid">
            {localTracks.map((song) => (
              <div className="all-page__row" key={song.id}>
                <SongArtwork
                  song={song}
                  wrapClassName="all-page__art"
                  fallbackClassName="all-page__art-fallback"
                  imageClassName="all-page__art-img"
                />
                <div className="all-page__info">
                  <strong>{song.title}</strong>
                  <small>{song.artistName}</small>
                </div>
                {song.durationSeconds ? (
                  <span className="all-page__duration">{formatSeconds(song.durationSeconds)}</span>
                ) : null}
                <SongActions
                  song={song}
                  playlists={playlists}
                  isFavorite={favoriteIds.includes(song.id)}
                  onPlay={onPlay}
                  onQueue={onQueue}
                  onToggleFavorite={onToggleFavorite}
                  onAddToPlaylist={onAddToPlaylist}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="all-page__section" aria-label="All songs">
        <h3>All Songs</h3>
        <div className="all-page__grid">
          {allSongs.map((song) => (
            <div className="all-page__row" key={song.id}>
              <SongArtwork
                song={song}
                wrapClassName="all-page__art"
                fallbackClassName="all-page__art-fallback"
                imageClassName="all-page__art-img"
              />
              <div className="all-page__info">
                <strong>{song.title}</strong>
                <small>{song.artistName}</small>
              </div>
              {song.durationSeconds ? (
                <span className="all-page__duration">{formatSeconds(song.durationSeconds)}</span>
              ) : null}
              <SongActions
                song={song}
                playlists={playlists}
                isFavorite={favoriteIds.includes(song.id)}
                onPlay={onPlay}
                onQueue={onQueue}
                onToggleFavorite={onToggleFavorite}
                onAddToPlaylist={onAddToPlaylist}
              />
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}
