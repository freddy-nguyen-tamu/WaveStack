import { useEffect, useState } from "react";
import type { Song } from "../App";

type SongArtworkProps = {
  song: Pick<Song, "id" | "artistName" | "thumbnailUrl">;
  wrapClassName: string;
  fallbackClassName: string;
  imageClassName?: string;
  loading?: "lazy" | "eager";
};

export function SongArtwork({
  song,
  wrapClassName,
  fallbackClassName,
  imageClassName,
  loading = "lazy"
}: SongArtworkProps) {
  const [failed, setFailed] = useState(false);
  const src = song.thumbnailUrl?.trim();

  useEffect(() => {
    setFailed(false);
  }, [song.id, src]);

  return (
    <span className={wrapClassName}>
      {src && !failed ? (
        <img
          className={imageClassName}
          src={src}
          alt=""
          loading={loading}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={fallbackClassName} aria-hidden="true">
          {song.artistName?.trim()?.charAt(0)?.toUpperCase() || "\u266A"}
        </span>
      )}
    </span>
  );
}
