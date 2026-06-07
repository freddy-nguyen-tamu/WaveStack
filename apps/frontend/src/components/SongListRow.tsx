import type { ClientPlaylist, Song } from "../App";
import { formatSeconds, formatSongDisplayName } from "../song-format";
import { SongActions } from "./SongActions";
import { SongArtwork } from "./SongArtwork";

type SongListRowProps = {
  song: Song;
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  index?: number;
  meta?: string;
  extraActions?: React.ReactNode;
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onOpenDetails?: (song: Song) => void;
};

export function SongListRow({
  song,
  playlists,
  favoriteIds,
  index,
  meta,
  onPlay,
  onQueue,
  onToggleFavorite,
  extraActions,
  onAddToPlaylist,
  onOpenDetails
}: SongListRowProps) {
  const displayName = formatSongDisplayName(song);
  const hasDuration = Number.isFinite(song.durationSeconds) && song.durationSeconds > 0;

  return (
    <li className="song-list-row">
      <button
        type="button"
        className="song-list-row__identity"
        onClick={() => onOpenDetails?.(song)}
        aria-label={`Open details for ${displayName}`}
      >
        <SongArtwork
          song={song}
          wrapClassName="song-list-row__art"
          fallbackClassName="song-list-row__art-fallback"
          imageClassName="song-list-row__art-image"
        />

        <span className="song-list-row__text">
          <strong className="song-list-row__title">
            {typeof index === "number" ? <span className="song-list-row__index">{index + 1}. </span> : null}
            {displayName}
          </strong>

          <small className="song-list-row__artist">
            {meta || song.albumTitle || song.sourceRootFolderId || "Unknown source"}
          </small>
        </span>
      </button>

      {hasDuration ? <span className="song-list-row__duration">{formatSeconds(song.durationSeconds)}</span> : null}

      <div className="song-list-row__actions">
        <SongActions
          song={song}
          playlists={playlists}
          isFavorite={favoriteIds.includes(song.id)}
          onPlay={onPlay}
          onQueue={onQueue}
          onToggleFavorite={onToggleFavorite}
          onAddToPlaylist={onAddToPlaylist}
        />
        {extraActions}
      </div>
    </li>
  );
}
