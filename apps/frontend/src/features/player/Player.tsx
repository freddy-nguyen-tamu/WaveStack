import { useEffect, useRef, useState } from "react";
import { Heart, Pause, Play, SkipForward, Trash2, Volume2 } from "lucide-react";
import type { Song } from "../../App";

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
  const [isPlaying, setIsPlaying] = useState(false);
  const [pendingAutoplay, setPendingAutoplay] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [playError, setPlayError] = useState("");

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    audioRef.current?.load();
    setIsPlaying(false);
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

  async function playCurrent() {
    if (!audioRef.current) return;

    try {
      setPlayError("");
      await audioRef.current.play();
      setIsPlaying(true);
    } catch (error) {
      setIsPlaying(false);
      setPlayError(error instanceof Error ? error.message : "Browser blocked playback.");
    }
  }

  async function togglePlay() {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    await playCurrent();
  }

  function skip() {
    if (!queue.length) {
      return;
    }

    const currentIndex = queue.findIndex((song) => song.id === activeSong.id);
    const nextSong = queue[currentIndex + 1] ?? queue[0];

    setPendingAutoplay(isPlaying);
    onActiveSongChange(nextSong);
    onQueueChange(queue);
  }

  function selectQueuedSong(song: Song) {
    setPendingAutoplay(true);
    onActiveSongChange(song);
  }

  return (
    <article>
      <h2>{activeSong.title}</h2>
      <p>
        {activeSong.artistName} - {activeSong.albumTitle}
      </p>

      <audio
        ref={audioRef}
        src={activeSong.streamUrl}
        controls
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={skip}
      />

      {playError ? <p role="alert">Playback error: {playError}</p> : null}

      <div>
        <button type="button" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {isPlaying ? " Pause" : " Play"}
        </button>

        <button type="button" onClick={skip} aria-label="Skip song">
          <SkipForward aria-hidden="true" /> Skip
        </button>

        <button type="button" onClick={onToggleFavorite} aria-pressed={isFavorite}>
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
            onChange={(event) => setVolume(Number(event.target.value))}
          />
        </label>
      </div>

      <section aria-label="Queue controls">
        <h3>Queue</h3>
        <button type="button" onClick={onQueueClear} disabled={!queue.length}>
          Clear queue
        </button>

        <ol aria-label="Queue">
          {queue.map((song) => (
            <li key={song.id}>
              <button type="button" onClick={() => selectQueuedSong(song)}>
                {song.id === activeSong.id ? "Now playing: " : "Play: "}
                {song.title}
              </button>
              <button type="button" onClick={() => onQueueRemove(song.id)} aria-label={`Remove ${song.title} from queue`}>
                <Trash2 aria-hidden="true" /> Remove
              </button>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
