import { useEffect, useRef, useState } from "react";
import { Pause, Play, SkipForward, Volume2 } from "lucide-react";
import type { Song } from "../../App";

type PlayerProps = {
  activeSong: Song;
  queue: Song[];
  onQueueChange: (songs: Song[]) => void;
};

export function Player({ activeSong, queue, onQueueChange }: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.7);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  async function togglePlay() {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    await audioRef.current.play();
    setIsPlaying(true);
  }

  function skip() {
    const [, ...nextQueue] = queue;
    onQueueChange(nextQueue.length ? nextQueue : queue);
  }

  return (
    <article>
      <h2>{activeSong.title}</h2>
      <p>
        {activeSong.artistName} - {activeSong.albumTitle}
      </p>
      <audio ref={audioRef} src={activeSong.streamUrl} controls preload="metadata" />
      <div>
        <button type="button" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <button type="button" onClick={skip} aria-label="Skip song">
          <SkipForward aria-hidden="true" />
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
      <ol aria-label="Queue">
        {queue.map((song) => (
          <li key={song.id}>{song.title}</li>
        ))}
      </ol>
    </article>
  );
}
