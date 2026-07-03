import { Heart, ListMusic, ListPlus, Play } from "lucide-react";
import { useId, useState } from "react";
import type { ClientPlaylist, PlaybackContext, PlaySongHandler, Song } from "../App";
import { formatSongDisplayName } from "../song-format";

type SongActionsProps = {
  song: Song;
  playlists: ClientPlaylist[];
  isFavorite: boolean;
  playbackContext?: PlaybackContext;
  onPlay: PlaySongHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void | Promise<void>;
  className?: string;
};

export function SongActions({
  song,
  playlists,
  isFavorite,
  playbackContext,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist,
  className = ""
}: SongActionsProps) {
  const [playlistPickerOpen, setPlaylistPickerOpen] = useState(false);
  const pickerId = useId();
  const songName = formatSongDisplayName(song);

  async function addToPlaylist(playlistId: string) {
    await onAddToPlaylist(playlistId, song);
    setPlaylistPickerOpen(false);
  }

  return (
    <div className={className ? `song-actions ${className}` : "song-actions"}>
      <div className="song-actions__buttons">
        <button type="button" onClick={() => onPlay(song, playbackContext)}>
          <Play aria-hidden="true" /> Play now
        </button>

        <button type="button" onClick={() => onQueue(song)}>
          <ListMusic aria-hidden="true" /> Queue
        </button>

        <button type="button" onClick={() => onToggleFavorite(song)} aria-pressed={isFavorite}>
          <Heart aria-hidden="true" /> {isFavorite ? "Unfavorite" : "Favorite"}
        </button>

        <button
          type="button"
          aria-expanded={playlistPickerOpen}
          aria-controls={pickerId}
          onClick={() => setPlaylistPickerOpen((open) => !open)}
        >
          <ListPlus aria-hidden="true" /> Add to playlist
        </button>
      </div>

      {playlistPickerOpen ? (
        <div className="song-actions__playlist-picker" id={pickerId} aria-label={`Choose playlist for ${songName}`}>
          {playlists.length ? (
            playlists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                onClick={() => void addToPlaylist(playlist.id)}
              >
                {playlist.name} ({playlist.songIds.length})
              </button>
            ))
          ) : (
            <p>No playlists yet.</p>
          )}

          <button type="button" onClick={() => void addToPlaylist("")}>
            <ListPlus aria-hidden="true" /> Add new playlist
          </button>
        </div>
      ) : null}
    </div>
  );
}
