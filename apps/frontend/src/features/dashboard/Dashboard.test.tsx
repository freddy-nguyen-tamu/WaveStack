import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dashboard } from "./Dashboard";

const noop = () => {};
const props = {
  loading: false,
  playlists: [],
  favoriteIds: [],
  onPlay: noop,
  onOpenDetails: noop,
  onQueue: noop,
  onToggleFavorite: noop,
  onAddToPlaylist: noop,
};

describe("dashboard recommendation loading status", () => {
  it("shows an accessible spinning indicator only during a batch fetch", () => {
    const view = render(<Dashboard {...props} loadingMoreRecommendations={false} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<Dashboard {...props} loadingMoreRecommendations />);
    const indicator = screen.getByRole("status");
    expect(indicator).toHaveTextContent("Loading more recommendations...");
    expect(indicator.querySelector("svg")).not.toBeNull();
    expect(indicator.closest(".dashboard-page__load-more")).not.toBeNull();
    view.rerender(<Dashboard {...props} loadingMoreRecommendations={false} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
