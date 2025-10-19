import { useEffect, useState } from "react";
import type { Song } from "../App";

type SongArtworkProps = {
  song: Pick<Song, "id" | "artistName" | "thumbnailUrl" | "driveThumbnailUrl" | "embeddedArtworkUrl">;
  wrapClassName: string;
  fallbackClassName: string;
  imageClassName?: string;
  loading?: "lazy" | "eager";
};

const FALLBACK_SRC: string[] = [];

export function SongArtwork({
  song,
  wrapClassName,
  fallbackClassName,
  imageClassName,
  loading = "lazy"
}: SongArtworkProps) {
  const srcChain = [
    song.thumbnailUrl?.trim(),
    song.driveThumbnailUrl?.trim(),
    song.embeddedArtworkUrl?.trim(),
    ...FALLBACK_SRC
  ].filter(Boolean) as string[];

  const [srcIndex, setSrcIndex] = useState(0);
  const currentSrc = srcChain[srcIndex];

  useEffect(() => {
    setSrcIndex(0);
  }, [song.id]);

  const handleError = () => {
    if (srcIndex < srcChain.length - 1) {
      setSrcIndex(srcIndex + 1);
    }
  };

  if (currentSrc) {
    return (
      <span className={wrapClassName}>
        <img
          className={imageClassName}
          src={currentSrc}
          alt=""
          loading={loading}
          onError={handleError}
        />
      </span>
    );
  }

  return (
    <span className={wrapClassName}>
      <span className={fallbackClassName} aria-hidden="true">
        {song.artistName?.trim()?.charAt(0)?.toUpperCase() || "\u266A"}
      </span>
    </span>
  );
}
