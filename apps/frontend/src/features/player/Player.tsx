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
import { NOW_PLAYING_DISC_DEGREES_PER_MS, type NowPlayingState } from "../../components/NowPlayingContext";

type PlayerPlaybackState = Pick<
  NowPlayingState,
  "isPlaying" | "hasPlaybackHistory" | "discBaseAngleDeg" | "discStartedAtMs"
>;

type PlayerProps = {
  activeSong: Song;
  queue: Song[];
  playSignal: number;
  isFavorite: boolean;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  canGoPrevious: boolean;
  resolvingNext?: boolean;
  onToggleFavorite: () => void;
  onToggleShuffle: () => void;
  onCycleRepeatMode: () => void;
  onQueueChange: (songs: Song[]) => void;
  onRefreshStreamUrl: (song: Song) => Promise<Song>;
  onOpenDetails: (song: Song) => void;
  onPlaybackStateChange: (state: PlayerPlaybackState) => void;
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
  resolvingNext = false,
  onToggleFavorite,
  onToggleShuffle,
  onCycleRepeatMode,
  onQueueChange,
  onRefreshStreamUrl,
  onOpenDetails,
  onPlaybackStateChange,
  onNext,
  onPrevious,
  onEnded
}: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const discAngleRef = useRef(0);
  const discTimestampRef = useRef<number | null>(null);
  const playRequestRef = useRef(0);
  const playPromiseRef = useRef<Promise<void> | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const desiredPlaybackRef = useRef(false);
  const currentSourceSongIdRef = useRef(activeSong.id);
  const sourcePlaySignalRef = useRef(playSignal);
  const recoveryAttemptsRef = useRef(0);
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const comboLockRef = useRef<"next" | "previous" | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasPlaybackHistory, setHasPlaybackHistory] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(activeSong.durationSeconds || 0);
  const [playError, setPlayError] = useState("");
  const [message, setMessage] = useState("");
  const [discSnapshot, setDiscSnapshot] = useState({
    baseAngleDeg: 0,
    startedAtMs: null as number | null
  });

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
    onPlaybackStateChange({
      isPlaying,
      hasPlaybackHistory,
      discBaseAngleDeg: discSnapshot.baseAngleDeg,
      discStartedAtMs: discSnapshot.startedAtMs
    });
  }, [discSnapshot.baseAngleDeg, discSnapshot.startedAtMs, hasPlaybackHistory, isPlaying, onPlaybackStateChange]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) return;

    const songChanged = currentSourceSongIdRef.current !== activeSong.id;
    const explicitPlayRequest = sourcePlaySignalRef.current !== playSignal;
    const resetForNewPlay = songChanged || explicitPlayRequest;
    const nextSource = resolveMediaUrl(activeSong.streamUrl);
    const currentSource = audio.src ? resolveMediaUrl(audio.src) : "";
    currentSourceSongIdRef.current = activeSong.id;
    sourcePlaySignalRef.current = playSignal;

    if (resetForNewPlay) {
      recoveryAttemptsRef.current = 0;
      playRequestRef.current += 1;
      desiredPlaybackRef.current = false;
      pendingSeekRef.current = null;
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // The fresh source may not have metadata yet; load() below starts at zero anyway.
      }
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(activeSong.durationSeconds || 0);
      setPlayError("");
      resetDiscRotation();
    }

    // Player-owned source assignment prevents React from interrupting an in-flight
    // recovery when a refreshed signed URL is written back to activeSong.
    if (currentSource !== nextSource) {
      const resumeAt = resetForNewPlay ? 0 : audio.currentTime || currentTime;
      pendingSeekRef.current = resumeAt > 0 ? resumeAt : null;
      audio.pause();
      audio.src = activeSong.streamUrl;
      audio.load();
      setIsPlaying(false);
    }
  }, [activeSong.id, activeSong.streamUrl, playSignal]);

  useEffect(() => {
    if (playSignal > 0) {
      void playCurrent();
    }
  }, [playSignal]);

  function normalizeDiscAngle(angle: number) {
    const normalizedAngle = angle % 360;
    return normalizedAngle < 0 ? normalizedAngle + 360 : normalizedAngle;
  }

  function getDiscNowMs() {
    return Number(document.timeline.currentTime ?? performance.now());
  }

  function startDiscRotation() {
    if (discTimestampRef.current !== null) {
      return;
    }

    discTimestampRef.current = getDiscNowMs();
    setDiscSnapshot({
      baseAngleDeg: discAngleRef.current,
      startedAtMs: discTimestampRef.current
    });
  }

  function pauseDiscRotation() {
    if (discTimestampRef.current === null) {
      return;
    }

    const elapsedMs = getDiscNowMs() - discTimestampRef.current;
    discAngleRef.current = normalizeDiscAngle(
      discAngleRef.current + elapsedMs * NOW_PLAYING_DISC_DEGREES_PER_MS
    );
    discTimestampRef.current = null;
    setDiscSnapshot({
      baseAngleDeg: discAngleRef.current,
      startedAtMs: null
    });
  }

  function resetDiscRotation() {
    discAngleRef.current = 0;
    discTimestampRef.current = null;
    setDiscSnapshot({
      baseAngleDeg: 0,
      startedAtMs: null
    });
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

  function resolveMediaUrl(url: string): string {
    if (!url) {
      return "";
    }

    try {
      return new URL(url, window.location.href).href;
    } catch {
      return url;
    }
  }

  function signedStreamUrlExpired(url: string): boolean {
    if (!/\/(?:drive\/stream|api\/uploads)\//.test(url)) {
      return false;
    }

    try {
      const expires = Number(new URL(url, window.location.origin).searchParams.get("expires"));
      return Number.isFinite(expires) && expires <= Math.floor(Date.now() / 1000) + 5;
    } catch {
      return false;
    }
  }

  function isRecoverablePlaybackError(error: unknown, audio: HTMLAudioElement): boolean {
    if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError")) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (/interrupted by a call to pause/i.test(message)) {
      return false;
    }

    const source = audio.currentSrc || audio.src || activeSong.streamUrl;
    return Boolean(audio.error) || /\/(?:drive\/stream|api\/uploads)\//.test(source);
  }

  function restorePendingSeek() {
    const audio = audioRef.current;
    const pendingSeek = pendingSeekRef.current;

    if (!audio || pendingSeek === null) {
      syncProgressFromAudio();
      return;
    }

    try {
      const maxTime = Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.max(0, audio.duration - 0.05)
        : pendingSeek;
      audio.currentTime = Math.min(pendingSeek, maxTime);
      setCurrentTime(audio.currentTime || pendingSeek);
      pendingSeekRef.current = null;
    } catch {
      // Some browsers do not allow seeking until a later readyState. Keep it pending.
    }

    syncProgressFromAudio();
  }

  async function refreshStreamForPlayback(audio: HTMLAudioElement): Promise<void> {
    const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : currentTime;
    const refreshed = await onRefreshStreamUrl(activeSong);

    if (!refreshed.streamUrl) {
      throw new Error("WaveStack did not return a fresh playback link.");
    }

    const currentSource = resolveMediaUrl(audio.currentSrc || audio.src);
    const nextSource = resolveMediaUrl(refreshed.streamUrl);

    if (currentSource !== nextSource) {
      pendingSeekRef.current = resumeAt > 0 ? resumeAt : null;
      audio.pause();
      audio.src = refreshed.streamUrl;
      audio.load();
    }
  }

  async function playCurrent(forceRefresh = false) {
    const audio = audioRef.current;

    if (!audio) return;

    desiredPlaybackRef.current = true;
    setHasPlaybackHistory(true);

    if (playPromiseRef.current) {
      const inFlightPlay = playPromiseRef.current;
      await inFlightPlay;

      // A quick pause -> play sequence can invalidate the first request while its
      // play() promise is still settling. Honor the latest intent instead of making
      // the user click several times to get out of that stale in-flight request.
      if (desiredPlaybackRef.current && audio.paused && !playPromiseRef.current) {
        return playCurrent(forceRefresh);
      }

      return;
    }

    const requestId = playRequestRef.current + 1;
    playRequestRef.current = requestId;

    const task = (async () => {
      try {
        setPlayError("");

        const currentSource = audio.currentSrc || audio.src || activeSong.streamUrl;
        if (forceRefresh || signedStreamUrlExpired(currentSource)) {
          await refreshStreamForPlayback(audio);
        }

        try {
          await audio.play();
        } catch (initialError) {
          if (
            !forceRefresh &&
            recoveryAttemptsRef.current < 2 &&
            isRecoverablePlaybackError(initialError, audio)
          ) {
            recoveryAttemptsRef.current += 1;
            await refreshStreamForPlayback(audio);
            await audio.play();
          } else {
            throw initialError;
          }
        }

        if (playRequestRef.current === requestId && desiredPlaybackRef.current) {
          setIsPlaying(true);
          setMessage(`Playing: ${displayName}`);
        }
      } catch (error) {
        if (playRequestRef.current !== requestId || !desiredPlaybackRef.current) {
          return;
        }

        setIsPlaying(false);
        const errorMessage = error instanceof Error ? error.message : "Browser blocked playback.";

        if (/interrupted by a call to pause/i.test(errorMessage)) {
          return;
        }

        // A failed play attempt is no longer "pending". Leaving this true makes
        // the next click behave like Pause, which is why playback can feel stuck.
        desiredPlaybackRef.current = false;
        setPlayError(errorMessage);
      } finally {
        playPromiseRef.current = null;
      }
    })();

    playPromiseRef.current = task;
    return task;
  }

  function pauseCurrent(messageText: string) {
    desiredPlaybackRef.current = false;
    playRequestRef.current += 1;
    pauseDiscRotation();
    audioRef.current?.pause();
    setIsPlaying(false);
    setMessage(messageText);
    syncProgressFromAudio();
  }

  async function togglePlay() {
    if (!audioRef.current) return;

    setHasPlaybackHistory(true);

    if (isPlaying || desiredPlaybackRef.current) {
      pauseCurrent(`Paused: ${displayName}`);
      return;
    }

    await playCurrent();
  }

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      const tagName = target.tagName.toLowerCase();

      return (
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        target.isContentEditable
      );
    }

    function blurActiveButtonLikeElement() {
      const activeElement = document.activeElement;

      if (!(activeElement instanceof HTMLElement)) {
        return;
      }

      if (activeElement.closest("button, [role='button']")) {
        activeElement.blur();
      }
    }

    function restartCurrentSong(): boolean {
      const audio = audioRef.current;

      if (!audio) {
        return false;
      }

      audio.currentTime = 0;
      setCurrentTime(0);
      setHasPlaybackHistory(true);
      setMessage(`Restarted: ${displayName}`);

      return true;
    }

    function handleSmartPrevious() {
      const audio = audioRef.current;
      const latestTime = audio?.currentTime ?? currentTime;

      if (latestTime > 5) {
        restartCurrentSong();
        return;
      }

      onPrevious();
    }

    function normalizeKey(event: KeyboardEvent): string {
      if (event.code === "ArrowRight" || event.key === "ArrowRight") {
        return "ArrowRight";
      }

      if (event.code === "ArrowLeft" || event.key === "ArrowLeft") {
        return "ArrowLeft";
      }

      if (event.code === "Space" || event.key === " ") {
        return "Space";
      }

      return event.key.toLowerCase();
    }

    function handleKeyboardControls(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      const key = normalizeKey(event);
      pressedKeysRef.current.add(key);

      blurActiveButtonLikeElement();

      const isSpace = key === "Space";
      const wantsNext =
        pressedKeysRef.current.has("x") && pressedKeysRef.current.has("ArrowRight");
      const wantsPrevious =
        pressedKeysRef.current.has("z") && pressedKeysRef.current.has("ArrowLeft");

      if (wantsNext) {
        event.preventDefault();

        if (comboLockRef.current !== "next") {
          comboLockRef.current = "next";
          onNext();
        }

        return;
      }

      if (wantsPrevious) {
        event.preventDefault();

        if (comboLockRef.current !== "previous") {
          comboLockRef.current = "previous";
          handleSmartPrevious();
        }

        return;
      }

      if (!isSpace) {
        return;
      }

      event.preventDefault();

      if (isPlaying || desiredPlaybackRef.current) {
        pauseCurrent(`Paused: ${displayName}`);
        return;
      }

      void playCurrent();
    }

    function handleKeyUp(event: KeyboardEvent) {
      const key = normalizeKey(event);
      pressedKeysRef.current.delete(key);

      if (
        !pressedKeysRef.current.has("x") ||
        !pressedKeysRef.current.has("ArrowRight")
      ) {
        if (comboLockRef.current === "next") {
          comboLockRef.current = null;
        }
      }

      if (
        !pressedKeysRef.current.has("z") ||
        !pressedKeysRef.current.has("ArrowLeft")
      ) {
        if (comboLockRef.current === "previous") {
          comboLockRef.current = null;
        }
      }
    }

    window.addEventListener("keydown", handleKeyboardControls);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyboardControls);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [isPlaying, activeSong.id, displayName, onNext, onPrevious]);

  useEffect(() => {
    function blurActivatedControl(event: Event) {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      const control = target.closest("button, [role='button']");

      if (!(control instanceof HTMLElement)) {
        return;
      }

      window.setTimeout(() => {
        if (document.activeElement === control || control.contains(document.activeElement)) {
          control.blur();
        }
      }, 0);
    }

    document.addEventListener("click", blurActivatedControl, true);
    document.addEventListener("pointerup", blurActivatedControl, true);

    return () => {
      document.removeEventListener("click", blurActivatedControl, true);
      document.removeEventListener("pointerup", blurActivatedControl, true);
    };
  }, []);

  function skip() {
    onNext();
  }

  function previous() {
    const audio = audioRef.current;
    const latestTime = audio?.currentTime ?? currentTime;

    if (latestTime > 5) {
      if (audio) {
        audio.currentTime = 0;
      }

      setCurrentTime(0);
      setHasPlaybackHistory(true);
      setMessage(`Restarted: ${displayName}`);
      return;
    }

    onPrevious();
  }

  function favorite() {
    onToggleFavorite();
    setMessage(isFavorite ? `Removed favorite: ${displayName}` : `Added favorite: ${displayName}`);
  }

  function resolveArtworkUrl(url: string): string {
    if (/^(?:https?:|blob:|data:)/i.test(url)) {
      return url;
    }

    if (url.startsWith("/drive/") || url.startsWith("/api/")) {
      try {
        return new URL(url, new URL(activeSong.streamUrl, window.location.href).origin).href;
      } catch {
        // Fall through to the WaveStack frontend origin.
      }
    }

    return new URL(url, window.location.origin).href;
  }

  function getMediaSessionArtwork(): MediaImage[] {
    const artworkSource = [
      activeSong.localThumbnailUrl,
      activeSong.thumbnailUrl,
      activeSong.driveThumbnailUrl,
      activeSong.embeddedArtworkUrl
    ].find((candidate) => Boolean(candidate?.trim()));

    if (artworkSource) {
      return [{ src: resolveArtworkUrl(artworkSource) }];
    }

    return [{
      src: new URL("/icon-512.png", window.location.origin).href,
      sizes: "512x512",
      type: "image/png"
    }];
  }

  useEffect(() => {
    if (!("mediaSession" in navigator) || !hasPlaybackHistory) return;
    const session = navigator.mediaSession;
    if (typeof MediaMetadata !== "undefined") {
      session.metadata = new MediaMetadata({
        title: songTitle,
        artist: songArtist,
        album: activeSong.albumTitle,
        artwork: getMediaSessionArtwork()
      });
    }
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => { void playCurrent(); },
      pause: () => pauseCurrent(`Paused: ${displayName}`),
      nexttrack: () => { if (!resolvingNext) onNext(); },
      previoustrack: previous
    };
    const registered: MediaSessionAction[] = [];
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action as MediaSessionAction, handler!);
        registered.push(action as MediaSessionAction);
      } catch { /* Some browsers support only a subset of media actions. */ }
    }
    return () => {
      registered.forEach(action => session.setActionHandler(action, null));
    };
  }, [activeSong, hasPlaybackHistory, onNext, onPrevious, resolvingNext]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !hasPlaybackHistory) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [hasPlaybackHistory, isPlaying]);

  useEffect(() => {
    return () => {
      if (!("mediaSession" in navigator)) return;
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
    };
  }, []);

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

  function handleAudioError() {
    const audio = audioRef.current;

    if (!audio || !desiredPlaybackRef.current) {
      return;
    }

    if (recoveryAttemptsRef.current >= 2) {
      desiredPlaybackRef.current = false;
      setIsPlaying(false);
      setPlayError("Playback failed after WaveStack refreshed the stream link.");
      return;
    }

    recoveryAttemptsRef.current += 1;
    void playCurrent(true);
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
          preload="metadata"
          controlsList="nodownload noplaybackrate noremoteplayback"
          onLoadedMetadata={restorePendingSeek}
          onTimeUpdate={() => {
            syncProgressFromAudio();
            if ((audioRef.current?.currentTime ?? 0) > 3) {
              recoveryAttemptsRef.current = 0;
            }
          }}
          onDurationChange={restorePendingSeek}
          onError={handleAudioError}
          onPlay={() => {
            startDiscRotation();
            setHasPlaybackHistory(true);
            setIsPlaying(true);
          }}
          onPause={() => {
            pauseDiscRotation();
            setIsPlaying(false);
            syncProgressFromAudio();
          }}
          onEnded={() => {
            desiredPlaybackRef.current = false;
            pauseDiscRotation();
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

          <button type="button" onClick={previous} aria-label="Restart current song or go to previous song">
            <SkipBack aria-hidden="true" /> Previous
          </button>

          <button type="button" onClick={skip} aria-label="Next song" aria-busy={resolvingNext} disabled={resolvingNext}>
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

        <p className="player-card__shortcuts">
          <kbd>Space</kbd> Play/Pause &middot; <kbd>Z</kbd> + <kbd>&larr;</kbd> Backtrack &middot; <kbd>X</kbd> + <kbd>&rarr;</kbd> Skip
        </p>

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

                <button type="button" aria-label="Restart current song or go to previous song" onClick={previous}>
                  <SkipBack aria-hidden="true" />
                </button>

                <button type="button" className="mini-player__play" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlay}>
                  {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>

                <button type="button" aria-label="Next song" onClick={skip} aria-busy={resolvingNext} disabled={resolvingNext}>
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

