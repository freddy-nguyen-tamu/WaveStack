import { useEffect, useMemo, useRef, useState } from "react";
import type { Song } from "../App";

type SongArtworkProps = {
  song: Pick<
    Song,
    "id" | "artistName" | "thumbnailUrl" | "localThumbnailUrl" | "embeddedArtworkUrl" | "driveThumbnailUrl"
  >;
  wrapClassName: string;
  fallbackClassName: string;
  imageClassName?: string;
  loading?: "lazy" | "eager";
  eager?: boolean;
};

const imageStatus = new Map<string, "loaded" | "failed">();

export function SongArtwork({
  song,
  wrapClassName,
  fallbackClassName,
  imageClassName,
  loading = "lazy",
  eager = false
}: SongArtworkProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(eager);
  const [sourceIndex, setSourceIndex] = useState(0);

  const sources = useMemo(
    () =>
      [
        song.localThumbnailUrl,
        song.thumbnailUrl,
        song.driveThumbnailUrl,
        song.embeddedArtworkUrl
      ]
        .map((item) => item?.trim())
        .filter((item): item is string => Boolean(item))
        .filter((item, index, array) => array.indexOf(item) === index)
        .filter((item) => imageStatus.get(item) !== "failed"),
    [song.localThumbnailUrl, song.thumbnailUrl, song.driveThumbnailUrl, song.embeddedArtworkUrl]
  );

  useEffect(() => {
    setSourceIndex(0);
  }, [song.id, sources.join("|")]);

  useEffect(() => {
    if (eager) {
      setIsNearViewport(true);
      return;
    }

    const node = rootRef.current;

    if (!node || !("IntersectionObserver" in window)) {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsNearViewport(entry.isIntersecting);
      },
      {
        root: null,
        rootMargin: "450px 0px 650px 0px",
        threshold: 0.01
      }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [song.id, eager]);

  const src = isNearViewport ? sources[sourceIndex] : undefined;

  return (
    <span ref={rootRef} className={wrapClassName} data-artwork-loaded={Boolean(src)}>
      {src ? (
        <img
          key={`${song.id}:${src}`}
          className={imageClassName}
          src={src}
          alt=""
          loading={loading}
          decoding="async"
          fetchPriority={eager ? "high" : "low"}
          onLoad={() => imageStatus.set(src, "loaded")}
          onError={() => {
            imageStatus.set(src, "failed");
            setSourceIndex((index) => index + 1);
          }}
        />
      ) : (
        <span className={fallbackClassName} aria-hidden="true">
          {song.artistName?.trim()?.charAt(0)?.toUpperCase() || "♪"}
        </span>
      )}
    </span>
  );
}
