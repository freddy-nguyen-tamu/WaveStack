import { Shuffle } from "lucide-react";
import { memo, useCallback, useMemo, useRef } from "react";
import type { OpenSongDetailsHandler, RecommendResult, Song } from "../../App";
import type { ClientPlaylist } from "../../App";
import { formatSeconds, getSongCardSize } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
import { LoadingStatus } from "../../components/LoadingStatus";
import { SongActions } from "../../components/SongActions";
import { RouteSticker } from "../../components/KeyboardShortcutsMenu";

type DashboardProps = {
  loading: boolean;
  recommendations?: RecommendResult[];
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  onPlay: (song: Song) => void;
  onOpenDetails: OpenSongDetailsHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  userName?: string;
  onLoadMoreRecommendations?: () => void;
  hasMoreRecommendations?: boolean;
  loadingMoreRecommendations?: boolean;
  onShuffleRecommendations?: () => void;
  shufflingRecommendations?: boolean;
};

type DashboardSongTileProps = {
  item: RecommendResult;
  index: number;
  playlists: ClientPlaylist[];
  isFavorite: boolean;
  onPlay: (song: Song) => void;
  onOpenDetails: OpenSongDetailsHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
};

const DashboardSongTile = memo(function DashboardSongTile({
  item,
  index,
  playlists,
  isFavorite,
  onPlay,
  onOpenDetails,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist
}: DashboardSongTileProps) {
  const song = item.song;
  const size = getSongCardSize(song, index);

  return (
    <article
      className={`song-tile dashboard-song-tile song-tile--${size}`}
      data-dashboard-tile={song.id}
    >
      <button
        className="song-tile__open"
        type="button"
        onClick={() => onOpenDetails(song)}
        aria-label={`Open metadata for ${song.artistName} - ${song.title}`}
      >
        <SongArtwork
          song={song}
          wrapClassName="song-tile__media"
          fallbackClassName="song-tile__fallback"
          disableNowPlayingStyle
        />

        <span className="song-tile__overlay">
          <span>
            <strong>{song.title}</strong>
            <small>{song.artistName}</small>
            {item.reason ? <small className="song-tile__reason">{item.reason}</small> : null}
          </span>
          <span className="song-tile__duration">{formatSeconds(song.durationSeconds)}</span>
        </span>
      </button>

      <SongActions
        song={song}
        playlists={playlists}
        isFavorite={isFavorite}
        onPlay={onPlay}
        onQueue={onQueue}
        onToggleFavorite={onToggleFavorite}
        onAddToPlaylist={onAddToPlaylist}
        className="song-actions--tile"
      />
    </article>
  );
});

export function Dashboard({
  loading,
  recommendations = [],
  playlists,
  favoriteIds,
  onPlay,
  onOpenDetails,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist,
  userName,
  onLoadMoreRecommendations,
  hasMoreRecommendations,
  loadingMoreRecommendations,
  onShuffleRecommendations,
  shufflingRecommendations
}: DashboardProps) {
  const handlersRef = useRef({ onPlay, onOpenDetails, onQueue, onToggleFavorite, onAddToPlaylist });
  handlersRef.current = { onPlay, onOpenDetails, onQueue, onToggleFavorite, onAddToPlaylist };

  const stableOnPlay = useCallback((song: Song) => handlersRef.current.onPlay(song), []);
  const stableOnOpenDetails = useCallback<OpenSongDetailsHandler>(
    (song, context) => handlersRef.current.onOpenDetails(song, context),
    []
  );
  const stableOnQueue = useCallback((song: Song) => handlersRef.current.onQueue(song), []);
  const stableOnToggleFavorite = useCallback((song: Song) => handlersRef.current.onToggleFavorite(song), []);
  const stableOnAddToPlaylist = useCallback(
    (playlistId: string, song: Song) => handlersRef.current.onAddToPlaylist(playlistId, song),
    []
  );

  const favoriteIdSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  // Keep the recommendation wall static while scrolling. The previous manual
  // windowing listened to every window scroll, forced layout reads, and replaced
  // whole rows whenever the visible range crossed a row boundary. That made
  // already-loaded content stutter because scrolling itself caused React work.
  // Memoized tiles plus CSS containment keep the DOM stable and let the browser
  // perform normal compositor-driven scrolling.
  const recommendationTiles = useMemo(() => recommendations.map((item, index) => (
    <DashboardSongTile
      key={item.song.id}
      item={item}
      index={index}
      playlists={playlists}
      isFavorite={favoriteIdSet.has(item.song.id)}
      onPlay={stableOnPlay}
      onOpenDetails={stableOnOpenDetails}
      onQueue={stableOnQueue}
      onToggleFavorite={stableOnToggleFavorite}
      onAddToPlaylist={stableOnAddToPlaylist}
    />
  )), [
    recommendations,
    playlists,
    favoriteIdSet,
    stableOnPlay,
    stableOnOpenDetails,
    stableOnQueue,
    stableOnToggleFavorite,
    stableOnAddToPlaylist
  ]);

  const recommendationSentinelRef = useInfiniteScroll({
    enabled: Boolean(onLoadMoreRecommendations),
    loading: Boolean(loadingMoreRecommendations),
    hasMore: Boolean(hasMoreRecommendations),
    onLoadMore: () => {
      onLoadMoreRecommendations?.();
    },
    rootMargin: "160px"
  });

  return (
    <article className="dashboard-page">
      <RouteSticker>Dashboard</RouteSticker>
      <h2 className="sr-only">{userName ? `Dashboard for ${userName}` : "Dashboard"}</h2>

      <div className="dashboard-page__toolbar">
        {loading ? <LoadingStatus label="Loading music data..." /> : <span aria-hidden="true" />}

        {onShuffleRecommendations ? (
          <button
            type="button"
            onClick={() => onShuffleRecommendations()}
            disabled={Boolean(shufflingRecommendations)}
          >
            <Shuffle aria-hidden="true" />
            {shufflingRecommendations ? "Shuffling..." : "Shuffle suggestions"}
          </button>
        ) : null}
      </div>

      {recommendations.length ? (
        <section
          className="song-masonry dashboard-song-masonry"
          aria-label="Suggested songs"
        >
          {recommendationTiles}
        </section>
      ) : (
        <p>
          {loadingMoreRecommendations ? "Loading random suggestions..." : "No random suggestions loaded yet."}
        </p>
      )}

      <div
        ref={recommendationSentinelRef}
        className="infinite-scroll-sentinel"
        aria-hidden="true"
      />

      {loadingMoreRecommendations ? (
        <LoadingStatus label="Loading more recommendations..." />
      ) : null}

      {!loadingMoreRecommendations && !hasMoreRecommendations && recommendations.length > 0 ? (
        <p className="infinite-scroll-status">You reached the end of the recommendation wall.</p>
      ) : null}
    </article>
  );
}
