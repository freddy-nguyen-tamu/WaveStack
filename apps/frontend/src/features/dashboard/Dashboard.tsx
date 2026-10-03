
import { Shuffle } from "lucide-react";
import { useMemo } from "react";
import type { OpenSongDetailsHandler, RecommendResult, Song } from "../../App";
import type { ClientPlaylist } from "../../App";
import { formatSeconds, getSongCardSize } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
import { LoadingStatus } from "../../components/LoadingStatus";
import { SongActions } from "../../components/SongActions";

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
  const reasonBySongId = useMemo(() => {
    const map = new Map<string, string>();

    for (const item of recommendations) {
      map.set(item.song.id, item.reason);
    }

    return map;
  }, [recommendations]);

  const suggestions = useMemo(() => {
    return recommendations.map((item) => item.song);
  }, [recommendations]);

  const recommendationSentinelRef = useInfiniteScroll({
    enabled: Boolean(onLoadMoreRecommendations),
    loading: Boolean(loadingMoreRecommendations),
    hasMore: Boolean(hasMoreRecommendations),
    onLoadMore: () => {
      onLoadMoreRecommendations?.();
    },
    rootMargin: "250px"
  });

  return (
    <article className="dashboard-page">
      <span className="route-sticker" aria-hidden="true">Dashboard</span>
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

      {suggestions.length ? (
        <section className="song-masonry" aria-label="Suggested songs">
          {suggestions.map((song, index) => {
            const size = getSongCardSize(song, index);
            const reason = reasonBySongId.get(song.id);

            return (
              <article className={`song-tile song-tile--${size}`} key={song.id}>
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
                  />

                  <span className="song-tile__overlay">
                    <span>
                      <strong>{song.title}</strong>
                      <small>{song.artistName}</small>
                      {reason ? <small className="song-tile__reason">{reason}</small> : null}
                    </span>
                    <span className="song-tile__duration">{formatSeconds(song.durationSeconds)}</span>
                  </span>
                </button>

                <SongActions
                  song={song}
                  playlists={playlists}
                  isFavorite={favoriteIds.includes(song.id)}
                  onPlay={onPlay}
                  onQueue={onQueue}
                  onToggleFavorite={onToggleFavorite}
                  onAddToPlaylist={onAddToPlaylist}
                  className="song-actions--tile"
                />
              </article>
            );
          })}
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

      {!loadingMoreRecommendations && !hasMoreRecommendations && suggestions.length > 0 ? (
        <p className="infinite-scroll-status">You reached the end of the recommendation wall.</p>
      ) : null}

    </article>
  );
}
