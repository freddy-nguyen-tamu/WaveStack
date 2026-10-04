
import { Check, Heart, ListMusic, ListPlus, Play } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ClientPlaylist, PlaybackContext, PlaySongHandler, Song } from "../App";
import { formatSongDisplayName } from "../song-format";

type SongActionsProps = {
  song: Song;
  playlists: ClientPlaylist[];
  isFavorite: boolean;
  playbackContext?: PlaybackContext;
  onPlay: PlaySongHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void | Promise<void>;
  className?: string;
};

export function SongActions({
  song,
  playlists,
  isFavorite,
  playbackContext,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist,
  className = ""
}: SongActionsProps) {
  const [playlistPickerOpen, setPlaylistPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const pickerId = useId();
  const songName = formatSongDisplayName(song);

  useLayoutEffect(() => {
    if (!playlistPickerOpen) return;
    function placeMenu() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: rect.bottom + 4,
        width,
        maxHeight: Math.max(40, Math.min(320, window.innerHeight - rect.bottom - 12))
      });
    }
    function dismissOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setPlaylistPickerOpen(false);
      }
    }
    function dismissWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPlaylistPickerOpen(false);
      }
    }
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissWithKeyboard, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissWithKeyboard, true);
    };
  }, [playlistPickerOpen]);

  async function addToPlaylist(playlistId: string) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);

    // A playlist click completes the picker interaction immediately. Persist the
    // change in the background instead of leaving the menu hanging open while a
    // network-backed playlist mutation finishes.
    setPlaylistPickerOpen(false);

    try {
      await onAddToPlaylist(playlistId, song);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className={className ? `song-actions ${className}` : "song-actions"}>
      <div className="song-actions__buttons">
        <button type="button" onClick={() => onPlay(song, playbackContext)}>
          <Play aria-hidden="true" /> Play now
        </button>

        <button type="button" onClick={() => onQueue(song)}>
          <ListMusic aria-hidden="true" /> Queue
        </button>

        <button type="button" onClick={() => onToggleFavorite(song)} aria-pressed={isFavorite}>
          <Heart aria-hidden="true" /> {isFavorite ? "Unfavorite" : "Favorite"}
        </button>

        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={playlistPickerOpen}
          aria-controls={pickerId}
          onClick={() => setPlaylistPickerOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setPlaylistPickerOpen(true);
            }
          }}
        >
          <ListPlus aria-hidden="true" /> Add to playlist
        </button>
      </div>

      {playlistPickerOpen ? createPortal(
        <div
          ref={menuRef}
          className="song-actions__playlist-picker song-actions__playlist-picker--popover"
          style={position}
          id={pickerId}
          role="menu"
          aria-busy={pending}
          aria-label={`Choose playlist for ${songName}`}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              event.preventDefault();
              setPlaylistPickerOpen(false);
            }
          }}
        >
          {playlists.length ? (
            playlists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={playlist.songIds.includes(song.id)}
                disabled={pending}
                onClick={() => void addToPlaylist(playlist.id)}
              >
                <Check className="song-actions__membership-check" aria-hidden="true" />
                <span>{playlist.name} ({playlist.songIds.length})</span>
              </button>
            ))
          ) : (
            <p>No playlists yet.</p>
          )}

          <button type="button" role="menuitem" disabled={pending} onClick={() => void addToPlaylist("")}>
            <ListPlus aria-hidden="true" /> Add new playlist
          </button>
        </div>,
        document.body
      ) : null}
    </div>
  );
}
