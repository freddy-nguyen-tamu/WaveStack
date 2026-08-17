import { type CSSProperties, type SyntheticEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Song } from "../App";
import { NOW_PLAYING_DISC_DEGREES_PER_MS, useNowPlayingForSong } from "./NowPlayingContext";

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
  disableNowPlayingStyle?: boolean;
};

const imageStatus = new Map<string, "loaded" | "failed">();
const normalizedDiscArtwork = new Map<string, string | null>();
const DISC_ANALYSIS_MAX_SIZE = 256;
const DISC_OUTPUT_SIZE = 512;

type PixelColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function getTimelineNowMs() {
  return typeof performance === "undefined" ? 0 : performance.now();
}

function normalizeDiscAngle(angle: number) {
  const normalizedAngle = angle % 360;
  return normalizedAngle < 0 ? normalizedAngle + 360 : normalizedAngle;
}

function averageCanvasCornerColor(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): PixelColor {
  const points = [
    [0, 0],
    [Math.max(0, width - 1), 0],
    [0, Math.max(0, height - 1)],
    [Math.max(0, width - 1), Math.max(0, height - 1)]
  ];

  const total = points.reduce(
    (sum, [x, y]) => {
      const offset = (y * width + x) * 4;

      return {
        r: sum.r + pixels[offset],
        g: sum.g + pixels[offset + 1],
        b: sum.b + pixels[offset + 2],
        a: sum.a + pixels[offset + 3]
      };
    },
    { r: 0, g: 0, b: 0, a: 0 }
  );

  return {
    r: total.r / points.length,
    g: total.g / points.length,
    b: total.b / points.length,
    a: total.a / points.length
  };
}

function findMeaningfulArtworkBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): Bounds | null {
  const background = averageCanvasCornerColor(pixels, width, height);
  const threshold = 36;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = pixels[offset + 3];

      if (alpha <= 18) {
        continue;
      }

      const colorDistance =
        Math.abs(pixels[offset] - background.r) +
        Math.abs(pixels[offset + 1] - background.g) +
        Math.abs(pixels[offset + 2] - background.b);
      const alphaDistance = Math.abs(alpha - background.a);

      if (colorDistance <= threshold && alphaDistance <= threshold) {
        continue;
      }

      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) {
    return null;
  }

  const meaningfulInset = Math.min(width, height) * 0.04;
  const hasPaddedEdge =
    left > meaningfulInset ||
    top > meaningfulInset ||
    width - right - 1 > meaningfulInset ||
    height - bottom - 1 > meaningfulInset;

  if (!hasPaddedEdge) {
    return null;
  }

  return { left, top, right, bottom };
}

function createNormalizedDiscArtwork(image: HTMLImageElement): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;

  if (!naturalWidth || !naturalHeight) {
    return null;
  }

  try {
    const scale = Math.min(1, DISC_ANALYSIS_MAX_SIZE / Math.max(naturalWidth, naturalHeight));
    const analysisWidth = Math.max(1, Math.round(naturalWidth * scale));
    const analysisHeight = Math.max(1, Math.round(naturalHeight * scale));
    const analysisCanvas = document.createElement("canvas");
    analysisCanvas.width = analysisWidth;
    analysisCanvas.height = analysisHeight;

    const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });

    if (!analysisContext) {
      return null;
    }

    analysisContext.imageSmoothingEnabled = true;
    analysisContext.imageSmoothingQuality = "high";
    analysisContext.drawImage(image, 0, 0, analysisWidth, analysisHeight);

    const pixels = analysisContext.getImageData(0, 0, analysisWidth, analysisHeight).data;
    const bounds = findMeaningfulArtworkBounds(pixels, analysisWidth, analysisHeight);

    if (!bounds) {
      return null;
    }

    const sourcePadding =
      Math.max(bounds.right - bounds.left + 1, bounds.bottom - bounds.top + 1) *
      0.015 /
      scale;
    const sourceLeft = Math.max(0, bounds.left / scale - sourcePadding);
    const sourceTop = Math.max(0, bounds.top / scale - sourcePadding);
    const sourceRight = Math.min(naturalWidth, (bounds.right + 1) / scale + sourcePadding);
    const sourceBottom = Math.min(naturalHeight, (bounds.bottom + 1) / scale + sourcePadding);
    const sourceWidth = sourceRight - sourceLeft;
    const sourceHeight = sourceBottom - sourceTop;

    if (sourceWidth < naturalWidth * 0.18 || sourceHeight < naturalHeight * 0.18) {
      return null;
    }

    const squareSize = Math.max(1, Math.min(sourceWidth, sourceHeight));
    const squareLeft = Math.max(0, Math.min(naturalWidth - squareSize, sourceLeft + (sourceWidth - squareSize) / 2));
    const squareTop = Math.max(0, Math.min(naturalHeight - squareSize, sourceTop + (sourceHeight - squareSize) / 2));
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = DISC_OUTPUT_SIZE;
    outputCanvas.height = DISC_OUTPUT_SIZE;

    const outputContext = outputCanvas.getContext("2d");

    if (!outputContext) {
      return null;
    }

    outputContext.imageSmoothingEnabled = true;
    outputContext.imageSmoothingQuality = "high";
    outputContext.drawImage(
      image,
      squareLeft,
      squareTop,
      squareSize,
      squareSize,
      0,
      0,
      DISC_OUTPUT_SIZE,
      DISC_OUTPUT_SIZE
    );

    return outputCanvas.toDataURL("image/webp", 0.9);
  } catch {
    return null;
  }
}

export function SongArtwork({
  song,
  wrapClassName,
  fallbackClassName,
  imageClassName,
  loading = "lazy",
  eager = false,
  disableNowPlayingStyle = false
}: SongArtworkProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(eager);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [normalizedDiscImage, setNormalizedDiscImage] = useState<{
    source: string;
    src: string;
  } | null>(null);
  const nowPlaying = useNowPlayingForSong(song.id);

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
  const shouldApplyNowPlayingStyle = !disableNowPlayingStyle && nowPlaying.isNowPlaying;
  const displaySrc =
    shouldApplyNowPlayingStyle && src && normalizedDiscImage?.source === src
      ? normalizedDiscImage.src
      : src;
  const artworkClassName = [
    wrapClassName,
    shouldApplyNowPlayingStyle ? "song-artwork--now-playing" : "",
    shouldApplyNowPlayingStyle && nowPlaying.isPlaying ? "song-artwork--playing" : "",
    shouldApplyNowPlayingStyle && !nowPlaying.isPlaying ? "song-artwork--paused" : ""
  ].filter(Boolean).join(" ");
  const artworkStyle = useMemo(() => {
    if (!shouldApplyNowPlayingStyle) {
      return undefined;
    }

    const currentAngleDeg =
      nowPlaying.isPlaying && nowPlaying.discStartedAtMs !== null
        ? normalizeDiscAngle(
            nowPlaying.discBaseAngleDeg +
              Math.max(0, getTimelineNowMs() - nowPlaying.discStartedAtMs) *
                NOW_PLAYING_DISC_DEGREES_PER_MS
          )
        : normalizeDiscAngle(nowPlaying.discBaseAngleDeg);

    return {
      "--now-playing-disc-angle": `${currentAngleDeg.toFixed(3)}deg`
    } as CSSProperties;
  }, [
    nowPlaying.discBaseAngleDeg,
    nowPlaying.discStartedAtMs,
    nowPlaying.isPlaying,
    shouldApplyNowPlayingStyle
  ]);

  useEffect(() => {
    if (!shouldApplyNowPlayingStyle || !src) {
      setNormalizedDiscImage(null);
      return;
    }

    const cached = normalizedDiscArtwork.get(src);

    if (cached !== undefined) {
      setNormalizedDiscImage(cached ? { source: src, src: cached } : null);
      return;
    }

    setNormalizedDiscImage(null);

    const image = imageRef.current;

    if (image?.complete && image.naturalWidth > 0) {
      normalizeLoadedDiscImage(image);
    }
  }, [shouldApplyNowPlayingStyle, src]);

  function normalizeLoadedDiscImage(image: HTMLImageElement) {
    if (!shouldApplyNowPlayingStyle || !src || normalizedDiscArtwork.has(src)) {
      return;
    }

    const normalized = createNormalizedDiscArtwork(image);
    normalizedDiscArtwork.set(src, normalized);

    if (normalized) {
      setNormalizedDiscImage({ source: src, src: normalized });
    }
  }

  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    if (src) {
      imageStatus.set(src, "loaded");
    }

    normalizeLoadedDiscImage(event.currentTarget);
  }

  return (
    <span
      ref={rootRef}
      className={artworkClassName}
      style={artworkStyle}
      data-artwork-loaded={Boolean(displaySrc)}
      data-now-playing={shouldApplyNowPlayingStyle ? "true" : undefined}
      data-playback-state={shouldApplyNowPlayingStyle ? (nowPlaying.isPlaying ? "playing" : "paused") : undefined}
    >
      {displaySrc ? (
        <img
          ref={imageRef}
          key={`${song.id}:${displaySrc}`}
          className={imageClassName}
          src={displaySrc}
          alt=""
          loading={loading}
          decoding="async"
          fetchPriority={eager ? "high" : "low"}
          onLoad={handleImageLoad}
          onError={() => {
            if (src) {
              imageStatus.set(src, "failed");
            }

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
