import { useEffect, useRef, useState } from "react";
import {
  Heart,
  ListMusic,
  Pause,
  Play,
  PlusCircle,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2
} from "lucide-react";
import type { Song } from "../../App";
import { formatSeconds, formatSongDisplayName, hasThumbnail } from "../../song-format";

type PlayerProps = {
  activeSong: Song;
  queue: Song[];
  playSignal: number;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onQueueChange: (songs: Song[]) => void;
  onActiveSongChange: (song: Song) => void;
  onQueueRemove: (songId: string) => void;
  onQueueClear: () => void;
};

export function Player({
  activeSong,
  queue,
  playSignal,
  isFavorite,
  onToggleFavorite,
  onQueueChange,
  onActiveSongChange,
  onQueueRemove,
  onQueueClear
}: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasPlaybackHistory, setHasPlaybackHistory] = useState(false);
  const [pendingAutoplay, setPendingAutoplay] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(activeSong.durationSeconds || 0);
  const [playError, setPlayError] = useState("");
  const [message, setMessage] = useState("");

  const displayName = formatSongDisplayName(activeSong);
  const safeDuration = duration || activeSong.durationSeconds || 0;
  const progressPercent = safeDuration > 0 ? Math.min(100, (currentTime / safeDuration) * 100) : 0;
  const coverInitial = activeSong.artistName?.trim()?.charAt(0)?.toUpperCase() || "\u266A";

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    audioRef.current?.load();
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
    if (!audioRef.current) return;

    try {
      setHasPlaybackHistory(true);
      setPlayError("");
      await audioRef.current.play();
      setIsPlaying(true);
      setMessage(`Playing: ${displayName}`);
    } catch (error) {
      setIsPlaying(false);
      setPlayError(error instanceof Error ? error.message : "Browser blocked playback.");
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

  function findCurrentQueueIndex() {
    return queue.findIndex((song) => song.id === activeSong.id);
  }

  function skip() {
    if (!queue.length) {
      setMessage("Queue is empty. Add songs before skipping.");
      return;
    }

    if (queue.length === 1) {
      setMessage("Only one song is in the queue.");
      return;
    }

    const currentIndex = findCurrentQueueIndex();
    const nextSong = queue[currentIndex + 1] ?? queue[0];

    setHasPlaybackHistory(true);
    setPendingAutoplay(isPlaying);
    onActiveSongChange(nextSong);
    onQueueChange(queue);
    setMessage(`Skipped to: ${formatSongDisplayName(nextSong)}`);
  }

  function previous() {
    if (!queue.length) {
      setMessage("Queue is empty.");
      return;
    }

    if (queue.length === 1) {
      setMessage("Only one song is in the queue.");
      return;
    }

    const currentIndex = findCurrentQueueIndex();
    const previousSong = currentIndex <= 0 ? queue[queue.length - 1] : queue[currentIndex - 1];

    setHasPlaybackHistory(true);
    setPendingAutoplay(isPlaying);
    onActiveSongChange(previousSong);
    setMessage(`Returned to: ${formatSongDisplayName(previousSong)}`);
  }

  function selectQueuedSong(song: Song) {
    setHasPlaybackHistory(true);
    setPendingAutoplay(true);
    onActiveSongChange(song);
    setMessage(`Selected from queue: ${formatSongDisplayName(song)}`);
  }

  function clearQueue() {
    onQueueClear();
    setMessage("Queue cleared.");
  }

  function removeQueuedSong(song: Song) {
    onQueueRemove(song.id);
    setMessage(`Removed from queue: ${formatSongDisplayName(song)}`);
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
        <h2>{formatSongDisplayName(activeSong)}</h2>
        <p>{activeSong.albumTitle}</p>

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
            skip();
          }}
        />

        {message ? <p role="status">{message}</p> : null}
        {playError ? <p role="alert">Playback error: {playError}</p> : null}

        <div className="player-actions">
          <button type="button" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {isPlaying ? " Pause" : " Play"}
          </button>

          <button type="button" onClick={previous} aria-label="Previous song" disabled={queue.length <= 1}>
            <SkipBack aria-hidden="true" /> Previous
          </button>

          <button type="button" onClick={skip} aria-label="Skip song" disabled={queue.length <= 1}>
            <SkipForward aria-hidden="true" /> Skip
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

        <section aria-label="Queue controls">
          <h3>Queue</h3>
          <button type="button" onClick={clearQueue} disabled={!queue.length}>
            Clear queue
          </button>

          {queue.length ? (
            <ol aria-label="Queue">
              {queue.map((song) => (
                <li key={song.id}>
                  <button type="button" onClick={() => selectQueuedSong(song)} aria-pressed={song.id === activeSong.id}>
                    {song.id === activeSong.id ? "Now playing: " : "Play: "}
                    {formatSongDisplayName(song)}
                  </button>
                  <button type="button" onClick={() => removeQueuedSong(song)} aria-label={`Remove ${formatSongDisplayName(song)} from queue`}>
                    <Trash2 aria-hidden="true" /> Remove
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p>The queue is empty.</p>
          )}
        </section>
      </article>

      {hasPlaybackHistory ? (
        <aside className="mini-player" aria-label="Now playing">
            <div className="mini-player__track">
              <div className="mini-player__cover" aria-hidden="true">
                {hasThumbnail(activeSong) ? (
                  <img src={activeSong.thumbnailUrl} alt="" />
                ) : (
                  coverInitial
                )}
              </div>

              <div className="mini-player__meta">
                <strong title={displayName}>{displayName}</strong>
                <span title={activeSong.albumTitle}>{activeSong.albumTitle}</span>
              </div>

              <button type="button" className="mini-player__icon-button" onClick={favorite} aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}>
                {isFavorite ? <Heart aria-hidden="true" fill="currentColor" /> : <PlusCircle aria-hidden="true" />}
              </button>
            </div>

            <div className="mini-player__center">
              <div className="mini-player__controls">
                <button type="button" onClick={previous} aria-label="Previous song" disabled={queue.length <= 1}>
                  <SkipBack aria-hidden="true" />
                </button>

                <button type="button" className="mini-player__play" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
                  {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>

                <button type="button" onClick={skip} aria-label="Next song" disabled={queue.length <= 1}>
                  <SkipForward aria-hidden="true" />
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
