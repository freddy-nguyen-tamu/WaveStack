import { Shuffle } from "lucide-react";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
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
  rowHeight: number;
  playlists: ClientPlaylist[];
  isFavorite: boolean;
  onPlay: (song: Song) => void;
  onOpenDetails: OpenSongDetailsHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
};

type DashboardWindow = {
  columns: number;
  rowHeight: number;
  startRow: number;
  endRow: number;
};

const DASHBOARD_OVERSCAN_ROWS = 2;
const DASHBOARD_DEFAULT_ROW_HEIGHT = 420;

function dashboardColumnCount(viewportWidth: number): number {
  if (viewportWidth <= 560) return 1;
  if (viewportWidth <= 760) return 2;
  if (viewportWidth <= 980) return 3;
  if (viewportWidth <= 1180) return 4;
  return 5;
}

function dashboardRowHeight(gridWidth: number, columns: number): number {
  const safeWidth = Math.max(1, gridWidth);
  const cardWidth = safeWidth / Math.max(1, columns);
  const chromeHeight = columns >= 4 ? 190 : columns === 3 ? 200 : columns === 2 ? 215 : 235;
  return Math.max(300, Math.ceil(cardWidth + chromeHeight));
}

const DashboardSongTile = memo(function DashboardSongTile({
  item,
  index,
  rowHeight,
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
      style={{ height: rowHeight }}
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
  const masonryRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [windowState, setWindowState] = useState<DashboardWindow>({
    columns: typeof window === "undefined" ? 5 : dashboardColumnCount(window.innerWidth),
    rowHeight: DASHBOARD_DEFAULT_ROW_HEIGHT,
    startRow: 0,
    endRow: 6
  });

  useLayoutEffect(() => {
    const masonry = masonryRef.current;

    if (!masonry) {
      return;
    }

    const updateWindow = () => {
      frameRef.current = null;

      const columns = dashboardColumnCount(window.innerWidth);
      const rowHeight = dashboardRowHeight(masonry.clientWidth, columns);
      const totalRows = Math.ceil(recommendations.length / columns);
      const gridTop = masonry.getBoundingClientRect().top + window.scrollY;
      const firstVisibleRow = Math.floor((window.scrollY - gridTop) / rowHeight);
      const lastVisibleRow = Math.ceil((window.scrollY + window.innerHeight - gridTop) / rowHeight);
      const startRow = Math.max(0, Math.min(totalRows, firstVisibleRow - DASHBOARD_OVERSCAN_ROWS));
      const endRow = Math.max(
        startRow,
        Math.min(totalRows, lastVisibleRow + DASHBOARD_OVERSCAN_ROWS)
      );

      setWindowState((current) => {
        if (
          current.columns === columns &&
          current.rowHeight === rowHeight &&
          current.startRow === startRow &&
          current.endRow === endRow
        ) {
          return current;
        }

        return { columns, rowHeight, startRow, endRow };
      });
    };

    const scheduleWindowUpdate = () => {
      if (frameRef.current !== null) {
        return;
      }

      frameRef.current = window.requestAnimationFrame(updateWindow);
    };

    updateWindow();
    window.addEventListener("scroll", scheduleWindowUpdate, { passive: true });
    window.addEventListener("resize", scheduleWindowUpdate, { passive: true });

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleWindowUpdate);
    resizeObserver?.observe(masonry);

    return () => {
      window.removeEventListener("scroll", scheduleWindowUpdate);
      window.removeEventListener("resize", scheduleWindowUpdate);
      resizeObserver?.disconnect();

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [recommendations.length]);

  const totalRows = Math.ceil(recommendations.length / windowState.columns);
  const firstIndex = Math.min(recommendations.length, windowState.startRow * windowState.columns);
  const lastIndex = Math.min(recommendations.length, windowState.endRow * windowState.columns);
  const topSpacerHeight = windowState.startRow * windowState.rowHeight;
  const bottomSpacerHeight = Math.max(0, (totalRows - windowState.endRow) * windowState.rowHeight);

  const visibleTiles = useMemo(() => recommendations.slice(firstIndex, lastIndex).map((item, localIndex) => {
    const index = firstIndex + localIndex;
    return (
      <DashboardSongTile
        key={item.song.id}
        item={item}
        index={index}
        rowHeight={windowState.rowHeight}
        playlists={playlists}
        isFavorite={favoriteIdSet.has(item.song.id)}
        onPlay={stableOnPlay}
        onOpenDetails={stableOnOpenDetails}
        onQueue={stableOnQueue}
        onToggleFavorite={stableOnToggleFavorite}
        onAddToPlaylist={stableOnAddToPlaylist}
      />
    );
  }), [
    recommendations,
    firstIndex,
    lastIndex,
    windowState.rowHeight,
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

  const masonryStyle = {
    "--dashboard-virtual-row-height": `${windowState.rowHeight}px`
  } as CSSProperties;

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
          ref={masonryRef}
          className="song-masonry dashboard-song-masonry--virtual"
          aria-label="Suggested songs"
          style={masonryStyle}
        >
          {topSpacerHeight > 0 ? (
            <div
              className="dashboard-virtual-spacer"
              style={{ height: topSpacerHeight }}
              aria-hidden="true"
            />
          ) : null}

          {visibleTiles}

          {bottomSpacerHeight > 0 ? (
            <div
              className="dashboard-virtual-spacer"
              style={{ height: bottomSpacerHeight }}
              aria-hidden="true"
            />
          ) : null}
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
