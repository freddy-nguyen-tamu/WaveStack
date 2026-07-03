import { useEffect, useMemo, useState } from "react";
import { useLazyQuery, useMutation, useQuery } from "@apollo/client";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Clock,
  Download,
  Headphones,
  Loader2,
  Mic2,
  TrendingUp
} from "lucide-react";
import {
  EXPORT_LISTENING_HABITS_MUTATION,
  RECENTLY_PLAYED_DETAILED_QUERY,
  TOP_ARTISTS_QUERY,
  TOP_GENRES_QUERY,
  TOP_TRACKS_QUERY
} from "../../api";
import type { ClientPlaylist, PlaybackContext, PlaySongHandler, Song } from "../../App";
import { SongActions } from "../../components/SongActions";
import { StatsPieChart } from "./components/StatsPieChart";
import { StatsReceipt } from "./components/StatsReceipt";
import { TasteComparisonPanel } from "./components/TasteComparisonPanel";
import { TasteJudgePanel } from "./components/TasteJudgePanel";

type StatsEntry = {
  key: string;
  label: string;
  subtitle: string;
  rank: number;
  previousRank: number;
  rankChange: number;
  playCount: number;
  totalDurationSeconds: number;
  songId?: string | null;
  thumbnailUrl?: string | null;
};

type RecentlyPlayedEntry = {
  songId: string;
  title: string;
  artistName: string;
  durationSeconds: number;
  completedPlayRatio: number;
  startedAt: string;
};

const PERIODS = [
  { key: "FOUR_WEEKS", label: "4 weeks" },
  { key: "SIX_MONTHS", label: "6 months" },
  { key: "TWELVE_MONTHS", label: "12 months" },
  { key: "ALL_TIME", label: "All time" }
] as const;

const PERIOD_LABEL_MAP: Record<string, string> = {
  FOUR_WEEKS: "4 weeks",
  SIX_MONTHS: "6 months",
  TWELVE_MONTHS: "12 months",
  ALL_TIME: "All time"
};

type Tab = "ARTISTS" | "GENRES" | "RECENT";

const TAB_LABELS: Record<Tab, string> = {
  ARTISTS: "Top Artists",
  GENRES: "Top Genres",
  RECENT: "Recently Played"
};

type DriveExportPanelProps = {
  period: string;
};

type StatsPageProps = {
  songs: Song[];
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  onPlay: PlaySongHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
};

function DriveExportPanel({ period }: DriveExportPanelProps) {
  const [exportData, { loading, data, error }] = useMutation(EXPORT_LISTENING_HABITS_MUTATION);

  async function handleExport() {
    const p = period === "ALL_TIME" ? "ALL" : period === "FOUR_WEEKS" ? "DAY" : period === "SIX_MONTHS" ? "MONTH" : "YEAR";
    await exportData({ variables: { period: p } });
  }

  return (
    <div className="drive-export-panel">
      <h4>
        <Download aria-hidden="true" /> Export to Google Drive
      </h4>
      <button type="button" className="drive-export-panel__btn" onClick={() => void handleExport()} disabled={loading}>
        {loading ? <Loader2 className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
        {loading ? " Exporting..." : " Export CSV"}
      </button>
      {data?.exportListeningHabits?.webViewLink && (
        <p className="drive-export-panel__success">
          Exported!{" "}
          <a href={data.exportListeningHabits.webViewLink} target="_blank" rel="noopener noreferrer">
            Open in Drive
          </a>
        </p>
      )}
      {data?.exportListeningHabits?.ok === false && (
        <p className="drive-export-panel__error">{data.exportListeningHabits.message}</p>
      )}
      {error && <p className="drive-export-panel__error">{error.message}</p>}
    </div>
  );
}

export function StatsPage({
  songs,
  playlists,
  favoriteIds,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist
}: StatsPageProps) {
  const [period, setPeriod] = useState<string>("FOUR_WEEKS");
  const [tab, setTab] = useState<Tab>("ARTISTS");
  const [receiptMode, setReceiptMode] = useState<"normal" | "brat">("normal");
  const [receiptLength, setReceiptLength] = useState<10 | 50>(10);

  const [topTracksQuery, { data: tracksData }] = useLazyQuery(TOP_TRACKS_QUERY, { fetchPolicy: "cache-and-network" });
  const [topArtistsQuery, { data: artistsData, loading: artistsLoading }] = useLazyQuery(TOP_ARTISTS_QUERY, { fetchPolicy: "cache-and-network" });
  const [topGenresQuery, { data: genresData, loading: genresLoading }] = useLazyQuery(TOP_GENRES_QUERY, { fetchPolicy: "cache-and-network" });
  const [recentQuery, { data: recentData, loading: recentLoading }] = useLazyQuery(RECENTLY_PLAYED_DETAILED_QUERY, { fetchPolicy: "cache-and-network" });

  const trackEntries: StatsEntry[] = useMemo(() => tracksData?.topTracks ?? [], [tracksData]);
  const artistEntries: StatsEntry[] = useMemo(() => artistsData?.topArtists ?? [], [artistsData]);
  const genreEntries: StatsEntry[] = useMemo(() => genresData?.topGenres ?? [], [genresData]);
  const recentEntries: RecentlyPlayedEntry[] = useMemo(() => recentData?.recentlyPlayedDetailed ?? [], [recentData]);
  const songById = useMemo(() => new Map(songs.map((song) => [song.id, song])), [songs]);
  const recentSongsForPlayback = useMemo(() => {
    const seen = new Set<string>();
    const orderedSongs: Song[] = [];

    for (const entry of recentEntries) {
      const song = songById.get(entry.songId);

      if (song && !seen.has(song.id)) {
        seen.add(song.id);
        orderedSongs.push(song);
      }
    }

    return orderedSongs;
  }, [recentEntries, songById]);
  const recentPlaybackContext = useMemo<PlaybackContext>(() => ({
    id: `stats:recent:${period}`,
    label: `Stats recently played (${PERIOD_LABEL_MAP[period] ?? period})`,
    source: "recent",
    songs: recentSongsForPlayback
  }), [period, recentSongsForPlayback]);

  useEffect(() => {
    if (period) {
      void topTracksQuery({ variables: { period, limit: 50 } });
      void topArtistsQuery({ variables: { period, limit: 50 } });
      void topGenresQuery({ variables: { period, limit: 50 } });
      void recentQuery({ variables: { period, limit: 50 } });
    }
  }, [period, topTracksQuery, topArtistsQuery, topGenresQuery, recentQuery]);

  const tabEntries = useMemo(() => {
    switch (tab) {
      case "ARTISTS": return artistEntries;
      case "GENRES": return genreEntries;
      default: return [];
    }
  }, [tab, artistEntries, genreEntries]);

  function RankChange({ entry }: { entry: StatsEntry }) {
    if (entry.rankChange === 0) {
      return (
        <span className="rank-change rank-change--same" title="Same position">
          —
        </span>
      );
    }

    if (entry.rankChange < 0) {
      return (
        <span className="rank-change rank-change--up" title={`Up ${Math.abs(entry.rankChange)} to #${entry.rank}`}>
          <ArrowUp aria-hidden="true" /> {Math.abs(entry.rankChange)}
        </span>
      );
    }

    return (
      <span className="rank-change rank-change--down" title={`Down ${entry.rankChange} to #${entry.rank}`}>
        <ArrowDown aria-hidden="true" /> {entry.rankChange}
      </span>
    );
  }

  function renderRankingList(entries: StatsEntry[], showSubtitle = true) {
    if (!entries.length) {
      return <p className="stats-page__empty">No data for this period yet.</p>;
    }

    return (
      <ol className="ranking-list">
        {entries.map((entry) => (
          <li key={entry.key} className="ranking-list__item">
            <span className="ranking-list__position">#{entry.rank}</span>

            <div className="ranking-list__info">
              <strong>{entry.label}</strong>
              {showSubtitle && entry.subtitle ? <small>{entry.subtitle}</small> : null}
            </div>

            <span className="ranking-list__count">{entry.playCount} plays</span>

            <RankChange entry={entry} />
          </li>
        ))}
      </ol>
    );
  }

  function renderRecentlyPlayed() {
    if (!recentEntries.length) {
      return <p className="stats-page__empty">No recently played songs for this period.</p>;
    }

    return (
      <ul className="recent-list">
        {recentEntries.map((entry, index) => {
          const date = new Date(entry.startedAt);
          const song = songById.get(entry.songId);

          return (
            <li key={`${entry.songId}-${index}`} className="recent-list__item">
              <span className="recent-list__time">
                {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>

              <div className="recent-list__info">
                <strong>{entry.title}</strong>
                <small>{entry.artistName}</small>
              </div>

              <span className="recent-list__ratio">
                {Math.round(entry.completedPlayRatio * 100)}%
              </span>

              {song ? (
                <SongActions
                  song={song}
                  playlists={playlists}
                  isFavorite={favoriteIds.includes(song.id)}
                  playbackContext={recentPlaybackContext}
                  onPlay={onPlay}
                  onQueue={onQueue}
                  onToggleFavorite={onToggleFavorite}
                  onAddToPlaylist={onAddToPlaylist}
                  className="song-actions--ranking"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  function renderSongPlayBarChart() {
    const entries = trackEntries.slice(0, 24);
    const maxPlays = Math.max(1, ...entries.map((entry) => entry.playCount));

    return (
      <section className="listening-bar-card" aria-label="Song play bar chart">
        <div>
          <p className="eyebrow">Song spread</p>
          <h3>How your plays stack up</h3>
        </div>

        {tracksData === undefined ? (
          <p className="stats-page__loading">Loading...</p>
        ) : entries.length ? (
          <div className="listening-bar-chart" role="img" aria-label="Bar chart of your top song play counts">
            {entries.map((entry) => {
              const height = Math.max(6, Math.round((entry.playCount / maxPlays) * 100));

              return (
                <div className="listening-bar-chart__bar" key={entry.key}>
                  <span style={{ "--bar-height": `${height}%` } as React.CSSProperties} />
                  <small>{entry.playCount}</small>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="stats-page__empty">No song plays for this period yet.</p>
        )}
      </section>
    );
  }

  const tabs: { key: Tab; icon: React.ReactNode; label: string }[] = [
    { key: "ARTISTS", icon: <Mic2 aria-hidden="true" />, label: "Top Artists" },
    { key: "GENRES", icon: <BarChart3 aria-hidden="true" />, label: "Top Genres" },
    { key: "RECENT", icon: <Clock aria-hidden="true" />, label: "Recently Played" }
  ];

  return (
    <article className="stats-page">
      <div className="stats-page__hero">
        <TrendingUp aria-hidden="true" />
        <h2>Listening Stats</h2>
        <p>Your listening history, ranked and analyzed.</p>
      </div>

      <div className="stats-page__periods">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`stats-page__period-btn ${period === p.key ? "stats-page__period-btn--active" : ""}`}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="stats-page__tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`stats-page__tab ${tab === t.key ? "stats-page__tab--active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* 1. VISUAL SUMMARY FIRST */}
      <section className="stats-page__visuals">
        <div className="stats-visual-grid">
          <StatsPieChart
            title="Artist pie"
            entries={(artistEntries ?? []).map((entry) => ({
              label: entry.label,
              value: entry.playCount
            }))}
          />

          <StatsPieChart
            title="Song pie"
            entries={(trackEntries ?? []).map((entry) => ({
              label: entry.label,
              value: entry.playCount
            }))}
          />
        </div>

        <TasteComparisonPanel period={period} />

        {renderSongPlayBarChart()}

        <TasteJudgePanel period={period} />

        <section className="stats-receipt-controls">
          <div>
            <p className="eyebrow">Receipt mode</p>
            <h3>Customize receipt</h3>
          </div>

          <div className="stats-tabs">
            <button
              type="button"
              className={receiptMode === "normal" ? "stats-tabs__button stats-tabs__button--active" : "stats-tabs__button"}
              onClick={() => setReceiptMode("normal")}
            >
              Normal
            </button>
            <button
              type="button"
              className="stats-tabs__button stats-tabs__button--brat-active"
              onClick={() => setReceiptMode("brat")}
            >
              Brat Edition
            </button>
          </div>

          <div className="stats-tabs">
            <button
              type="button"
              className={receiptLength === 10 ? "stats-tabs__button stats-tabs__button--active" : "stats-tabs__button"}
              onClick={() => setReceiptLength(10)}
            >
              Top 10
            </button>
            <button
              type="button"
              className={receiptLength === 50 ? "stats-tabs__button stats-tabs__button--active" : "stats-tabs__button"}
              onClick={() => setReceiptLength(50)}
            >
              Top 50
            </button>
          </div>
        </section>

        <StatsReceipt
          title={TAB_LABELS[tab]}
          periodLabel={PERIOD_LABEL_MAP[period] ?? period}
          entries={tabEntries.map((entry) => ({
            label: entry.label,
            subtitle: entry.subtitle,
            playCount: entry.playCount,
            totalDurationSeconds: entry.totalDurationSeconds
          }))}
          mode={receiptMode}
          length={receiptLength}
        />

        <DriveExportPanel period={period} />
      </section>

      {/* 2. DETAILED LIST LAST */}
      <section className="stats-page__content stats-page__content--details" aria-label="Detailed ranking">
        <div className="stats-page__header-row">
          <div>
            <p className="eyebrow">Detailed ranking</p>
            <h3>{TAB_LABELS[tab]}</h3>
          </div>
        </div>

        {tab === "ARTISTS" && (
          <>
            {artistsLoading ? <p className="stats-page__loading">Loading...</p> : renderRankingList(artistEntries)}
          </>
        )}

        {tab === "GENRES" && (
          <>
            {genresLoading ? <p className="stats-page__loading">Loading...</p> : renderRankingList(genreEntries)}
          </>
        )}

        {tab === "RECENT" && (
          <>
            {recentLoading ? <p className="stats-page__loading">Loading...</p> : renderRecentlyPlayed()}
          </>
        )}
      </section>

      <div className="bottom-player-spacer" aria-hidden="true" />
    </article>
  );
}
