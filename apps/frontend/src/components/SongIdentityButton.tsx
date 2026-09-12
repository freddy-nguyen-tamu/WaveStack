import type { OpenSongDetailsHandler, PlaybackContext, Song } from "../App";
import { formatSongDisplayName, normalizeLabelPart } from "../song-format";
import { SongArtwork } from "./SongArtwork";

type SongIdentityButtonProps = {
  song: Song;
  index?: number;
  subtitle?: string;
  className?: string;
  artClassName?: string;
  fallbackClassName?: string;
  imageClassName?: string;
  bodyClassName?: string;
  playbackContext?: PlaybackContext;
  onOpenDetails: OpenSongDetailsHandler;
};

export function SongIdentityButton({
  song,
  index,
  subtitle,
  className = "song-identity-button",
  artClassName = "song-list-row__art",
  fallbackClassName = "song-list-row__art-fallback",
  imageClassName = "song-list-row__art-image",
  bodyClassName = "song-identity-button__body",
  playbackContext,
  onOpenDetails
}: SongIdentityButtonProps) {
  const displayName = formatSongDisplayName(song);
  const title = normalizeLabelPart(song.title, displayName);
  const artist = normalizeLabelPart(song.artistName, "Unknown Artist");

  return (
    <button
      type="button"
      className={className}
      onClick={() => onOpenDetails(song, playbackContext)}
      aria-label={`Open details for ${displayName}`}
    >
      <SongArtwork
        song={song}
        wrapClassName={artClassName}
        fallbackClassName={fallbackClassName}
        imageClassName={imageClassName}
      />
      <span className={bodyClassName}>
        <strong>
          {typeof index === "number" ? (
            <>
              <span className="song-list-row__index">{index}.</span>{" "}
            </>
          ) : null}
          {title}
        </strong>
        <small>{subtitle ?? artist}</small>
      </span>
    </button>
  );
}
