import { Shuffle } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
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

// Dashboard recommendations accumulate by design. Keeping every previously
// visited card's image, four action buttons, SVGs and React subtree mounted made
// the route progressively slower as more pages were loaded. One shared observer
// keeps only cards near the viewport fully mounted while lightweight shells keep
// the document geometry stable.
type TileVisibilityCallback = (visible: boolean) => void;
const dashboardTileCallbacks = new Map<Element, TileVisibilityCallback>();
let dashboardTileObserver: IntersectionObserver | null = null;

function observeDashboardTile(node: Element, callback: TileVisibilityCallback): () => void {
  if (!("IntersectionObserver" in window)) {
    callback(true);
    return () => {};
  }

  dashboardTileObserver ??= new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        dashboardTileCallbacks.get(entry.target)?.(entry.isIntersecting);
      }
    },
    {
      root: null,
      // Mount well before a card becomes visible so image decode/layout happens
      // off-screen instead of during the user's scroll frame.
      rootMargin: "1400px 0px 1400px 0px",
      threshold: 0
    }
  );

  dashboardTileCallbacks.set(node, callback);
  dashboardTileObserver.observe(node);

  return () => {
    dashboardTileObserver?.unobserve(node);
    dashboardTileCallbacks.delete(node);

    if (!dashboardTileCallbacks.size) {
      dashboardTileObserver?.disconnect();
      dashboardTileObserver = null;
    }
  };
}

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
  const rootRef = useRef<HTMLElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(index < 15);
  const [measuredHeight, setMeasuredHeight] = useState(0);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;

    return observeDashboardTile(node, setIsNearViewport);
  }, []);

  useLayoutEffect(() => {
    if (!isNearViewport) return;

    const node = rootRef.current;
    if (!node) return;

    const rememberHeight = () => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height > 0) {
        setMeasuredHeight(current => Math.abs(current - height) > 1 ? height : current);
      }
    };

    rememberHeight();

    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(rememberHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isNearViewport]);

  return (
    <article
      ref={rootRef}
      className={`song-tile dashboard-song-tile song-tile--${size}${isNearViewport ? "" : " song-tile--virtualized"}`}
      style={!isNearViewport && measuredHeight ? { minHeight: `${measuredHeight}px` } : undefined}
      data-dashboard-tile={song.id}
    >
      {isNearViewport ? (
        <>
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
        </>
      ) : (
        <span className="dashboard-song-tile__virtual-placeholder" aria-hidden="true" />
      )}
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
  // App owns several unrelated pieces of state, so these callback props can be
  // recreated even when the recommendation wall itself did not change. Keep a
  // stable dispatcher identity so already-mounted tiles do not all rerender on
  // those parent updates.
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

  const tiles = useMemo(() => recommendations.map((item, index) => (
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

      {tiles.length ? (
        <section className="song-masonry" aria-label="Suggested songs">
          {tiles}
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

      {!loadingMoreRecommendations && !hasMoreRecommendations && tiles.length > 0 ? (
        <p className="infinite-scroll-status">You reached the end of the recommendation wall.</p>
      ) : null}
    </article>
  );
}
