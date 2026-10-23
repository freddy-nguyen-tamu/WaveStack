import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SongActions } from "./SongActions";
import type { Song } from "../App";

const song: Song = {
  id: "test-favorite", title: "Instant Heart", artistName: "Singer", albumTitle: "Single",
  durationSeconds: 120, streamUrl: "/song.mp3", genreNames: []
};

describe("immediate favorite controls", () => {
  it("shows the new favorite state before a parent or network update", () => {
    const toggle = vi.fn();
    const props = { song, playlists: [], isFavorite: false,
      onPlay: vi.fn(), onQueue: vi.fn(), onToggleFavorite: toggle, onAddToPlaylist: vi.fn() };
    const view = render(<SongActions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));
    expect(screen.getByRole("button", { name: "Unfavorite" })).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveBeenCalledWith(song);
    view.rerender(<SongActions {...props} />);
    expect(screen.getByRole("button", { name: "Unfavorite" })).toBeInTheDocument();
    view.rerender(<SongActions {...props} isFavorite />);
    expect(screen.getByRole("button", { name: "Unfavorite" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Unfavorite" }));
    expect(screen.getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "false");
  });
});
