import { useEffect, useMemo, useState } from "react";
import { useLazyQuery, useMutation, useQuery } from "@apollo/client";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Clock,
  Download,
  Disc3,
  Headphones,
  Mic2,
  PlusCircle,
  TrendingUp,
  User
} from "lucide-react";
import type { ClientPlaylist, Song } from "../../App";
import {
  PLACEMENT_HISTORY_QUERY,
  PREVIOUS_STATS_SNAPSHOTS_QUERY,
  RECENTLY_PLAYED_DETAILED_QUERY,
  SAVE_STATS_SNAPSHOT_MUTATION,
  TOP_ARTISTS_QUERY,
  TOP_GENRES_QUERY,
  TOP_TRACKS_QUERY
} from "../../api";
import { formatSongDisplayName } from "../../song-format";

type StatsEntry = {
  songId: string;
  title: string;
  artistName: string;
  albumTitle?: string;
  playCount: number;
  previousPosition?: number | null;
  position?: number | null;
};

type RecentlyPlayedEntry = {
  songId: string;
  title: string;
  artistName: string;
  albumTitle?: string;
  playedAt: string;
  completedPlayRatio: number;
};

type StatsSnapshot = {
  id: string;
  label: string;
  createdAt: string;
  entries: StatsEntry[];
};

type PlacementPoint = {
  snapshotId: string;
  label: string;
  createdAt: string;
  position?: number | null;
};

const PERIODS = [
  { key: "FOUR_WEEKS", label: "4 weeks" },
  { key: "SIX_MONTHS", label: "6 months" },
  { key: "TWELVE_MONTHS", label: "12 months" },
  { key: "ALL_TIME", label: "All time" }
] as const;

type Tab = "TRACKS" | "ARTISTS" | "GENRES" | "RECENT";

type StatsPageProps = {
  onPlay: (song: Song) => void;
  playlists: ClientPlaylist[];
  onCreatePlaylist: (name: string) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  getSongById: (id: string) => Song | undefined;
};

const LISTENING_STATS_ENTRY_FRAGMENT = `
  fragment ListeningStatsEntryFields on ListeningStatsEntry {
    songId
    title
    artistName
    playCount
    position
    previousPosition
  }
`;

export function StatsPage({ onPlay, playlists, onCreatePlaylist, onAddToPlaylist, getSongById }: StatsPageProps) {
  const [period, setPeriod] = useState<string>("FOUR_WEEKS");
  const [tab, setTab] = useState<Tab>("TRACKS");
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [snapshotMessage, setSnapshotMessage] = useState("");

  const [topTracksQuery, { data: tracksData, loading: tracksLoading }] = useLazyQuery(TOP_TRACKS_QUERY, { fetchPolicy: "cache-and-network" });
  const [topArtistsQuery, { data: artistsData, loading: artistsLoading }] = useLazyQuery(TOP_ARTISTS_QUERY, { fetchPolicy: "cache-and-network" });
  const [topGenresQuery, { data: genresData, loading: genresLoading }] = useLazyQuery(TOP_GENRES_QUERY, { fetchPolicy: "cache-and-network" });
  const [recentQuery, { data: recentData, loading: recentLoading }] = useLazyQuery(RECENTLY_PLAYED_DETAILED_QUERY, { fetchPolicy: "cache-and-network" });

  const { data: snapshotsData, refetch: refetchSnapshots } = useQuery(PREVIOUS_STATS_SNAPSHOTS_QUERY, { fetchPolicy: "cache-and-network" });

  const [saveSnapshot] = useMutation(SAVE_STATS_SNAPSHOT_MUTATION);

  const trackEntries: StatsEntry[] = useMemo(() => tracksData?.topTracks ?? [], [tracksData]);
  const artistEntries: StatsEntry[] = useMemo(() => artistsData?.topArtists ?? [], [artistsData]);
  const genreEntries: StatsEntry[] = useMemo(() => genresData?.topGenres ?? [], [genresData]);
  const recentEntries: RecentlyPlayedEntry[] = useMemo(() => recentData?.recentlyPlayedDetailed ?? [], [recentData]);
  const snapshots: StatsSnapshot[] = useMemo(() => snapshotsData?.previousStatsSnapshots ?? [], [snapshotsData]);

  useEffect(() => {
    if (period) {
      void topTracksQuery({ variables: { period, limit: 50 } });
      void topArtistsQuery({ variables: { period, limit: 50 } });
      void topGenresQuery({ variables: { period, limit: 50 } });
      void recentQuery({ variables: { period, limit: 50 } });
    }
  }, [period, topTracksQuery, topArtistsQuery, topGenresQuery, recentQuery]);

  async function handleSaveSnapshot() {
    const label = snapshotLabel.trim() || `Snapshot ${new Date().toLocaleDateString()}`;
    setSnapshotMessage("");

    try {
      const result = await saveSnapshot({ variables: { label, period } });
      if (result.data?.saveStatsSnapshot?.id) {
        setSnapshotMessage(`Saved snapshot: ${label}`);
        setSnapshotLabel("");
        await refetchSnapshots();
      }
    } catch (err) {
      setSnapshotMessage(err instanceof Error ? err.message : "Failed to save snapshot");
    }
  }

  function createTopPlaylist(entries: StatsEntry[]) {
    const name = `Top ${period} - ${new Date().toLocaleDateString()}`;
    onCreatePlaylist(name);
  }

  function RankChange({ entry }: { entry: StatsEntry }) {
    if (entry.previousPosition == null || entry.position == null) {
      return null;
    }

    const diff = entry.previousPosition - entry.position;

    if (diff > 0) {
      return (
        <span className="rank-change rank-change--up" title={`Up ${diff} from #${entry.previousPosition}`}>
          <ArrowUp aria-hidden="true" /> {diff}
        </span>
      );
    }

    if (diff < 0) {
      return (
        <span className="rank-change rank-change--down" title={`Down ${Math.abs(diff)} from #${entry.previousPosition}`}>
          <ArrowDown aria-hidden="true" /> {Math.abs(diff)}
        </span>
      );
    }

    return (
      <span className="rank-change rank-change--same" title="Same position">
        —
      </span>
    );
  }

  function renderRankingList(entries: StatsEntry[], showArtist = true, showSong = true) {
    if (!entries.length) {
      return <p className="stats-page__empty">No data for this period yet.</p>;
    }

    return (
      <ol className="ranking-list">
        {entries.map((entry, index) => {
          const song = showSong ? getSongById(entry.songId) : undefined;

          return (
            <li key={`${entry.songId || entry.artistName || entry.title}-${index}`} className="ranking-list__item">
              <span className="ranking-list__position">#{index + 1}</span>

              <div className="ranking-list__info">
                {showSong ? (
                  <>
                    <strong>{entry.title}</strong>
                    {showArtist && entry.artistName ? <small>{entry.artistName}</small> : null}
                  </>
                ) : (
                  <strong>{entry.artistName || entry.title}</strong>
                )}
              </div>

              <span className="ranking-list__count">{entry.playCount} plays</span>

              <RankChange entry={entry} />

              {song ? (
                <button
                  type="button"
                  className="ranking-list__play"
                  onClick={() => onPlay(song)}
                  aria-label={`Play ${formatSongDisplayName(song)}`}
                >
                  <Headphones aria-hidden="true" />
                </button>
              ) : null}
            </li>
          );
        })}
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
          const song = getSongById(entry.songId);
          const date = new Date(entry.playedAt);

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
                <button
                  type="button"
                  className="ranking-list__play"
                  onClick={() => onPlay(song)}
                  aria-label={`Play ${formatSongDisplayName(song)}`}
                >
                  <Headphones aria-hidden="true" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  function renderSnapshots() {
    if (!snapshots.length) {
      return <p className="stats-page__empty">No snapshots saved yet. Save one above.</p>;
    }

    return (
      <div className="snapshots-list">
        {snapshots.map((snap) => (
          <details key={snap.id} className="snapshot-card">
            <summary className="snapshot-card__summary">
              <strong>{snap.label}</strong>
              <span>{new Date(snap.createdAt).toLocaleDateString()} — {snap.entries.length} entries</span>
            </summary>
            <div className="snapshot-card__content">
              {renderRankingList(snap.entries.slice(0, 20), true, true)}
            </div>
          </details>
        ))}
      </div>
    );
  }

  const tabs: { key: Tab; icon: React.ReactNode; label: string }[] = [
    { key: "TRACKS", icon: <Disc3 aria-hidden="true" />, label: "Top Tracks" },
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

      <section className="stats-page__content" aria-label="Statistics content">
        {tab === "TRACKS" && (
          <>
            <div className="stats-page__header-row">
              <h3>Top Tracks</h3>
              {trackEntries.length > 0 ? (
                <button type="button" className="stats-page__action-btn" onClick={() => createTopPlaylist(trackEntries)}>
                  <PlusCircle aria-hidden="true" /> Create playlist
                </button>
              ) : null}
            </div>
            {tracksLoading ? <p className="stats-page__loading">Loading...</p> : renderRankingList(trackEntries, true, true)}
          </>
        )}

        {tab === "ARTISTS" && (
          <>
            <h3>Top Artists</h3>
            {artistsLoading ? <p className="stats-page__loading">Loading...</p> : renderRankingList(artistEntries, false, false)}
          </>
        )}

        {tab === "GENRES" && (
          <>
            <h3>Top Genres</h3>
            {genresLoading ? <p className="stats-page__loading">Loading...</p> : renderRankingList(genreEntries, false, false)}
          </>
        )}

        {tab === "RECENT" && (
          <>
            <h3>Recently Played</h3>
            {recentLoading ? <p className="stats-page__loading">Loading...</p> : renderRecentlyPlayed()}
          </>
        )}
      </section>

      <section className="stats-page__snapshots" aria-label="Snapshots">
        <h3>
          <Download aria-hidden="true" /> Save Snapshot
        </h3>

        <div className="stats-page__save-row">
          <input
            type="text"
            placeholder="Snapshot label (optional)"
            value={snapshotLabel}
            onChange={(e) => setSnapshotLabel(e.target.value)}
          />
          <button type="button" onClick={() => void handleSaveSnapshot()}>
            <Download aria-hidden="true" /> Save
          </button>
        </div>

        {snapshotMessage ? <p className="stats-page__message">{snapshotMessage}</p> : null}

        <h4>Previous Snapshots</h4>
        {renderSnapshots()}
      </section>

      <div className="bottom-player-spacer" aria-hidden="true" />
    </article>
  );
}
