import { useEffect, useRef, useState } from "react";
import {
  Heart,
  ListMusic,
  Pause,
  Play,
  PlusCircle,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2
} from "lucide-react";
import type { RepeatMode, Song } from "../../App";
import { formatSeconds, formatSongDisplayName } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";

type PlayerProps = {
  activeSong: Song;
  queue: Song[];
  playSignal: number;
  isFavorite: boolean;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  canGoPrevious: boolean;
  onToggleFavorite: () => void;
  onToggleShuffle: () => void;
  onCycleRepeatMode: () => void;
  onQueueChange: (songs: Song[]) => void;
  onActiveSongChange: (song: Song) => void;
  onOpenDetails: (song: Song) => void;
  onNext: () => void;
  onPrevious: () => void;
  onEnded: () => void;
};

export function Player({
  activeSong,
  queue,
  playSignal,
  isFavorite,
  shuffleEnabled,
  repeatMode,
  canGoPrevious,
  onToggleFavorite,
  onToggleShuffle,
  onCycleRepeatMode,
  onQueueChange,
  onActiveSongChange,
  onOpenDetails,
  onNext,
  onPrevious,
  onEnded
}: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const playRequestRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasPlaybackHistory, setHasPlaybackHistory] = useState(false);
  const [pendingAutoplay, setPendingAutoplay] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(activeSong.durationSeconds || 0);
  const [playError, setPlayError] = useState("");
  const [message, setMessage] = useState("");

  const displayName = formatSongDisplayName(activeSong);
  const songTitle = activeSong.title?.trim() || "Untitled Track";
  const songArtist = activeSong.artistName?.trim() || "Unknown Artist";
  const safeDuration = duration || activeSong.durationSeconds || 0;
  const progressPercent = safeDuration > 0 ? Math.min(100, (currentTime / safeDuration) * 100) : 0;

  const repeatLabel =
    repeatMode === "one"
      ? "Repeat one"
      : repeatMode === "all"
        ? "Repeat list"
        : "No repeat";

  const RepeatIcon = repeatMode === "one" ? Repeat1 : Repeat;

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) return;

    playRequestRef.current += 1;
    audio.pause();
    audio.load();
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(activeSong.durationSeconds || 0);
    setPlayError("");

    if (pendingAutoplay) {
      void playCurrent();
      setPendingAutoplay(false);
    }
  }, [activeSong.id]);

  useEffect(() => {
    if (playSignal > 0) {
      void playCurrent();
    }
  }, [playSignal]);

  useEffect(() => {
    if (!isPlaying) {
      stopProgressLoop();
      return;
    }

    updateProgressLoop();

    return stopProgressLoop;
  }, [isPlaying]);

  function stopProgressLoop() {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function updateProgressLoop() {
    const audio = audioRef.current;

    if (audio) {
      setCurrentTime(audio.currentTime || 0);

      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    }

    animationFrameRef.current = window.requestAnimationFrame(updateProgressLoop);
  }

  function syncProgressFromAudio() {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    setCurrentTime(audio.currentTime || 0);

    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    }
  }

  async function playCurrent() {
    const audio = audioRef.current;

    if (!audio) return;

    const requestId = playRequestRef.current + 1;
    playRequestRef.current = requestId;

    try {
      setHasPlaybackHistory(true);
      setPlayError("");
      await audio.play();

      if (playRequestRef.current === requestId) {
        setIsPlaying(true);
        setMessage(`Playing: ${displayName}`);
      }
    } catch (error) {
      if (playRequestRef.current !== requestId) {
        return;
      }

      setIsPlaying(false);
      const message = error instanceof Error ? error.message : "Browser blocked playback.";

      if (message.includes("interrupted by a call to pause")) {
        return;
      }

      setPlayError(message);
    }
  }

  async function togglePlay() {
    if (!audioRef.current) return;

    setHasPlaybackHistory(true);

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      setMessage(`Paused: ${displayName}`);
      return;
    }

    await playCurrent();
  }

  function skip() {
    onNext();
  }

  function previous() {
    onPrevious();
  }

  function favorite() {
    onToggleFavorite();
    setMessage(isFavorite ? `Removed favorite: ${displayName}` : `Added favorite: ${displayName}`);
  }

  function handleSeek(value: string) {
    const nextTime = Number(value);

    if (!Number.isFinite(nextTime) || !audioRef.current) {
      return;
    }

    audioRef.current.currentTime = nextTime;
    setCurrentTime(nextTime);
    setHasPlaybackHistory(true);
  }

  function changeVolume(value: string) {
    const nextVolume = Number(value);

    if (!Number.isFinite(nextVolume)) {
      return;
    }

    setVolume(nextVolume);
  }

  return (
    <>
      <article className="player-card">
        <div className="player-card__identity">
          <h2 title={songTitle}>{songTitle}</h2>
          <p title={songArtist}>{songArtist}</p>
        </div>

        <audio
          ref={audioRef}
          src={activeSong.streamUrl}
          preload="metadata"
          onLoadedMetadata={syncProgressFromAudio}
          onTimeUpdate={syncProgressFromAudio}
          onDurationChange={syncProgressFromAudio}
          onPlay={() => {
            setHasPlaybackHistory(true);
            setIsPlaying(true);
          }}
          onPause={() => {
            setIsPlaying(false);
            syncProgressFromAudio();
          }}
          onEnded={() => {
            setIsPlaying(false);
            onEnded();
          }}
        />

        {message ? <p className="player-card__message" role="status" title={message}>{message}</p> : null}
        {playError ? <p role="alert">Playback error: {playError}</p> : null}

        <div className="player-actions">
          <button type="button" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {isPlaying ? " Pause" : " Play"}
          </button>

          <button type="button" onClick={previous} aria-label="Previous song" disabled={!canGoPrevious}>
            <SkipBack aria-hidden="true" /> Previous
          </button>

          <button type="button" onClick={skip} aria-label="Next song">
            <SkipForward aria-hidden="true" /> Next
          </button>

          <button type="button" onClick={onToggleShuffle} aria-pressed={shuffleEnabled} aria-label="Toggle shuffle">
            <Shuffle aria-hidden="true" /> Shuffle
          </button>

          <button type="button" onClick={onCycleRepeatMode} aria-pressed={repeatMode !== "none"} aria-label={repeatLabel}>
            <RepeatIcon aria-hidden="true" /> {repeatLabel}
          </button>

          <button type="button" onClick={favorite} aria-pressed={isFavorite}>
            <Heart aria-hidden="true" /> {isFavorite ? "Unfavorite" : "Favorite"}
          </button>

          <label>
            <Volume2 aria-hidden="true" /> Volume
            <input
              aria-label="Volume"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) => changeVolume(event.target.value)}
            />
          </label>
        </div>

        <div className="player-card__progress-wrap">
          <span>{formatSeconds(currentTime)}</span>

          <label className="sr-only" htmlFor="player-card-seek">
            Seek playback position
          </label>

          <input
            id="player-card-seek"
            className="player-card__progress"
            type="range"
            min="0"
            max={Math.max(safeDuration, 1)}
            step="0.1"
            value={Math.min(currentTime, Math.max(safeDuration, 1))}
            onChange={(event) => handleSeek(event.target.value)}
            style={{ "--progress": `${progressPercent}%` } as React.CSSProperties}
            aria-label="Seek playback position"
          />

          <span>{formatSeconds(safeDuration)}</span>
        </div>

      </article>

      {hasPlaybackHistory ? (
        <aside className="mini-player" aria-label="Now playing">
            <div className="mini-player__track">
              <button
                type="button"
                className="mini-player__cover-button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenDetails(activeSong);
                }}
                aria-label={`Open details for ${displayName}`}
                title={`Open details for ${displayName}`}
              >
                <SongArtwork
                  song={activeSong}
                  wrapClassName="mini-player__cover"
                  fallbackClassName="mini-player__cover-fallback"
                  loading="eager"
                  eager
                />
              </button>

              <div className="mini-player__meta">
                <button
                  type="button"
                  className="mini-player__meta-button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenDetails(activeSong);
                  }}
                  title={`Open details for ${displayName}`}
                >
                  <strong title={songTitle}>{songTitle}</strong>
                  <span title={songArtist}>{songArtist}</span>
                </button>
              </div>

              <button type="button" className="mini-player__icon-button" onClick={favorite} aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}>
                {isFavorite ? <Heart aria-hidden="true" fill="currentColor" /> : <PlusCircle aria-hidden="true" />}
              </button>
            </div>

            <div className="mini-player__center">
              <div className="mini-player__controls">
                <button
                  type="button"
                  aria-label="Toggle shuffle"
                  aria-pressed={shuffleEnabled}
                  onClick={onToggleShuffle}
                  className={shuffleEnabled ? "mini-player__mode-button mini-player__mode-button--shuffle mini-player__mode-button--active" : "mini-player__mode-button mini-player__mode-button--shuffle"}
                  title={shuffleEnabled ? "Shuffle on" : "Shuffle off"}
                >
                  <Shuffle aria-hidden="true" />
                </button>

                <button type="button" aria-label="Previous song" onClick={previous} disabled={!canGoPrevious}>
                  <SkipBack aria-hidden="true" />
                </button>

                <button type="button" className="mini-player__play" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlay}>
                  {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>

                <button type="button" aria-label="Next song" onClick={skip}>
                  <SkipForward aria-hidden="true" />
                </button>

                <button
                  type="button"
                  aria-label={repeatLabel}
                  aria-pressed={repeatMode !== "none"}
                  onClick={onCycleRepeatMode}
                  className={`mini-player__mode-button mini-player__mode-button--repeat mini-player__mode-button--repeat-${repeatMode}${repeatMode !== "none" ? " mini-player__mode-button--active" : ""}`}
                  title={repeatLabel}
                >
                  <RepeatIcon aria-hidden="true" />
                </button>
              </div>

              <div className="mini-player__progress">
                <span>{formatSeconds(currentTime)}</span>
                <label className="sr-only" htmlFor="mini-player-seek">
                  Seek playback position
                </label>
                <input
                  id="mini-player-seek"
                  type="range"
                  min="0"
                  max={Math.max(safeDuration, 1)}
                  step="0.1"
                  value={Math.min(currentTime, Math.max(safeDuration, 1))}
                  onChange={(event) => handleSeek(event.target.value)}
                  style={{ "--progress": `${progressPercent}%` } as React.CSSProperties}
                />
                <span>{formatSeconds(safeDuration)}</span>
              </div>
            </div>

            <div className="mini-player__right">
              <ListMusic aria-hidden="true" />
              <Volume2 aria-hidden="true" />
              <label className="sr-only" htmlFor="mini-player-volume">
                Volume
              </label>
              <input
                id="mini-player-volume"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => changeVolume(event.target.value)}
                aria-label="Volume"
              />
            </div>
        </aside>
      ) : null}
    </>
  );
}
