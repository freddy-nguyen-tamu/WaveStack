import { Activity, Clock, Flame, Heart, Shuffle, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { HabitSummaryEntry, RecommendResult, Song } from "../../App";
import type { ClientPlaylist } from "../../App";
import { formatSeconds, getSongCardSize } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";
import { SongMetadataModal } from "./SongMetadataModal";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
import { SongActions } from "../../components/SongActions";

type DashboardProps = {
  loading: boolean;
  songs: Song[];
  favorites: Song[];
  recentlyPlayed: Song[];
  recommendations?: RecommendResult[];
  habitSummaries: Record<string, HabitSummaryEntry[]>;
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  onPlay: (song: Song) => void;
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
  songs,
  favorites,
  recentlyPlayed,
  recommendations = [],
  habitSummaries,
  playlists,
  favoriteIds,
  onPlay,
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
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);

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

  useEffect(() => {
    if (!selectedSong) {
      document.body.classList.remove("modal-open");
      return;
    }

    document.body.classList.add("modal-open");

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedSong(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedSong]);

  const recommendationSentinelRef = useInfiniteScroll({
    enabled: Boolean(onLoadMoreRecommendations),
    loading: Boolean(loadingMoreRecommendations),
    hasMore: Boolean(hasMoreRecommendations),
    onLoadMore: () => {
      onLoadMoreRecommendations?.();
    },
    rootMargin: "250px"
  });

  const periodLabels: Record<string, string> = {
    DAY: "Today",
    WEEK: "This week",
    MONTH: "This month",
    YEAR: "This year"
  };

  const periodIcons: Record<string, React.ReactNode> = {
    DAY: <Clock aria-hidden="true" />,
    WEEK: <Activity aria-hidden="true" />,
    MONTH: <Flame aria-hidden="true" />,
    YEAR: <TrendingUp aria-hidden="true" />
  };

  return (
    <article className="dashboard-page">
      <div className="dashboard-page__header">
        <div>
          <p className="eyebrow">{userName ? "Random discovery" : "Public discovery"}</p>
          <h2>{userName ? `Random picks for ${userName}` : "Random songs"}</h2>
          <p>
            Suggestions are intentionally random because this library has messy filenames and incomplete metadata.
            Shuffle anytime to discover a different set of tracks.
          </p>
        </div>

        <div className="dashboard-page__actions">
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

          {loading ? <p>Loading music data...</p> : null}
        </div>
      </div>

      <section className="dashboard-stats" aria-label="Library summary">
        <div>
          <TrendingUp aria-hidden="true" />
          <strong>{songs.length}</strong>
          <span>Total songs</span>
        </div>
        <div>
          <Heart aria-hidden="true" />
          <strong>{favorites.length}</strong>
          <span>Favorites</span>
        </div>
        <div>
          <Activity aria-hidden="true" />
          <strong>{recentlyPlayed.length}</strong>
          <span>Recently played</span>
        </div>
      </section>

      {(Object.keys(habitSummaries).length > 0) ? (
        <section className="habit-grid" aria-label="Listening habits">
          {Object.entries(habitSummaries).filter(([, entries]) => entries.length > 0).map(([period, entries]) => (
            <div key={period} className="habit-card">
              <h3>{periodIcons[period] ?? null} {periodLabels[period] ?? period}</h3>
              {entries.slice(0, 5).map((entry) => (
                <div key={entry.label} className="habit-card__row">
                  <span className="habit-card__label">{entry.label}</span>
                  <span className="habit-card__count">{entry.count} play(s)</span>
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : null}

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
                  onClick={() => setSelectedSong(song)}
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
        <p className="infinite-scroll-status">Loading more recommendations...</p>
      ) : null}

      {!loadingMoreRecommendations && !hasMoreRecommendations && suggestions.length > 0 ? (
        <p className="infinite-scroll-status">You reached the end of the recommendation wall.</p>
      ) : null}

      {selectedSong ? (
        <SongMetadataModal
          song={selectedSong}
          onPlay={() => onPlay(selectedSong)}
          onQueue={() => onQueue(selectedSong)}
          isFavorite={favoriteIds.includes(selectedSong.id)}
          playlists={playlists}
          onToggleFavorite={() => onToggleFavorite(selectedSong)}
          onAddToPlaylist={(playlistId) => onAddToPlaylist(playlistId, selectedSong)}
          onClose={() => setSelectedSong(null)}
        />
      ) : null}
    </article>
  );
}
