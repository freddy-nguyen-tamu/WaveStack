import { CalendarDays, Clock, DownloadCloud, Heart, ListMusic, UserCircle } from "lucide-react";
import { useMemo } from "react";
import { useMutation } from "@apollo/client";
import type { AuthUser, ClientPlaylist, HabitSummaryEntry, OpenSongDetailsHandler, PlaybackContext, PlaySongHandler, Song } from "../../App";
import { EXPORT_LISTENING_HABITS_MUTATION, TEST_PRIVATE_DRIVE_WRITE_MUTATION } from "../../api";
import { formatSeconds } from "../../song-format";
import { SongArtwork } from "../../components/SongArtwork";
import { SongActions } from "../../components/SongActions";
import { SongIdentityButton } from "../../components/SongIdentityButton";
import { ListeningArchivePanel } from "./ListeningArchivePanel";

type DriveExportResult = {
  ok: boolean;
  message: string;
  folderId?: string;
  credentialsPath?: string;
  fileId?: string;
  webViewLink?: string;
};

type ProfilePageProps = {
  user: AuthUser | null;
  songs: Song[];
  favorites: Song[];
  recentlyPlayed: Song[];
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  queueLength: number;
  habitSummaries: Record<string, HabitSummaryEntry[]>;
  onLogout: () => void;
  onPlay: PlaySongHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onOpenDetails: OpenSongDetailsHandler;
};

const periodLabels: Record<string, string> = {
  DAY: "Today",
  WEEK: "This week",
  MONTH: "This month",
  YEAR: "This year"
};

const periodOrder = ["DAY", "WEEK", "MONTH", "YEAR"];

function normalizeHabitLabel(value: string) {
  return value.trim().toLowerCase();
}

function hashHabitLabel(value: string) {
  return Array.from(value).reduce((total, character) => total + character.charCodeAt(0), 0);
}

function pickHabitArtworkSong(entry: HabitSummaryEntry, songs: Song[], index: number): Song | null {
  if (!songs.length) {
    return null;
  }

  const label = normalizeHabitLabel(entry.label);
  const matches = label && label !== "unknown"
    ? songs.filter((song) => {
        const searchable = [
          song.artistName,
          song.title,
          song.albumTitle,
          song.fileName,
          ...song.genreNames
        ].filter(Boolean).join(" ").toLowerCase();

        return searchable.includes(label);
      })
    : [];
  const candidates = matches.length ? matches : songs;
  const pickIndex = Math.abs(hashHabitLabel(`${entry.label}:${index}`)) % candidates.length;

  return candidates[pickIndex] ?? null;
}

export function ProfilePage({
  user,
  songs,
  favorites,
  recentlyPlayed,
  playlists,
  favoriteIds,
  queueLength,
  habitSummaries,
  onLogout,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist,
  onOpenDetails
}: ProfilePageProps) {
  const [testDriveWrite, testResult] = useMutation<{ testPrivateDriveWrite: DriveExportResult }>(
    TEST_PRIVATE_DRIVE_WRITE_MUTATION
  );

  const [exportHabits, exportResult] = useMutation<{ exportListeningHabits: DriveExportResult }>(
    EXPORT_LISTENING_HABITS_MUTATION
  );

  const latestExport =
    exportResult.data?.exportListeningHabits ??
    testResult.data?.testPrivateDriveWrite ??
    null;
  const recentPlaybackContext = useMemo<PlaybackContext>(() => ({
    id: "profile:recent",
    label: "Profile recently played",
    source: "profile",
    songs: recentlyPlayed
  }), [recentlyPlayed]);

  if (!user) {
    return (
      <article className="profile-page" aria-label="Profile">
        <div className="profile-hero">
          <UserCircle aria-hidden="true" />
          <div>
            <p className="eyebrow">Profile</p>
            <h2>Sign in to personalize WaveStack</h2>
            <p>
              Google login enables listening-history recommendations, daily and
              weekly habit summaries, and future private Drive exports.
            </p>
          </div>
        </div>
      </article>
    );
  }

  const totalPlays = Object.values(habitSummaries)
    .flat()
    .reduce((total, entry) => total + entry.count, 0);
  const artworkPool = songs.length ? songs : [...recentlyPlayed, ...favorites];
  const habitPeriods = periodOrder
    .map((period) => [period, habitSummaries[period] ?? []] as const)
    .filter(([, entries]) => entries.length > 0);

  return (
    <article className="profile-page" aria-label="Profile">
      <section className="profile-hero">
        {user.avatarUrl ? (
          <img className="profile-hero__avatar" src={user.avatarUrl} alt="" />
        ) : (
          <UserCircle aria-hidden="true" />
        )}

        <div>
          <p className="eyebrow">Signed in with Google</p>
          <h2>{user.displayName}</h2>
          <p>{user.email}</p>

          <div className="profile-hero__actions">
            <button type="button" onClick={onLogout}>
              Log out
            </button>
          </div>
        </div>
      </section>

      <div className="profile-page__content">
        <section className="profile-recent-panel" aria-label="Recently played">
          <div className="profile-section-heading">
            <p className="eyebrow">History</p>
            <h3>Recently played</h3>
          </div>

          {recentlyPlayed.length ? (
            <div className="profile-song-list">
              {recentlyPlayed.slice(0, 8).map((song) => (
                <div key={song.id} className="profile-song-list__item">
                  <SongIdentityButton
                    song={song}
                    subtitle={song.artistName}
                    className="song-identity-button profile-song-list__identity"
                    artClassName="profile-song-list__art"
                    fallbackClassName="profile-song-list__fallback"
                    playbackContext={recentPlaybackContext}
                    onOpenDetails={onOpenDetails}
                  />
                  <SongActions
                    song={song}
                    playlists={playlists}
                    isFavorite={favoriteIds.includes(song.id)}
                    playbackContext={recentPlaybackContext}
                    onPlay={onPlay}
                    onQueue={onQueue}
                    onToggleFavorite={onToggleFavorite}
                    onAddToPlaylist={onAddToPlaylist}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p>No recent songs yet.</p>
          )}
        </section>

        <aside className="profile-insights-rail" aria-label="Profile listening overview">
          <section className="profile-visual-stats" aria-label="Profile stats">
            <div className="profile-visual-stat">
              <div className="profile-visual-stat__media" aria-hidden="true">
                {favorites[0] ? (
                  <SongArtwork
                    song={favorites[0]}
                    wrapClassName="profile-visual-stat__art"
                    fallbackClassName="profile-visual-stat__art-fallback"
                    disableNowPlayingStyle
                  />
                ) : (
                  <span className="profile-visual-stat__art-fallback"><Heart /></span>
                )}
                <span className="profile-visual-stat__icon"><Heart /></span>
              </div>
              <strong>{favorites.length}</strong>
              <span>Favorites</span>
            </div>

            <div className="profile-visual-stat">
              <div className="profile-visual-stat__media" aria-hidden="true">
                {recentlyPlayed[0] ? (
                  <SongArtwork
                    song={recentlyPlayed[0]}
                    wrapClassName="profile-visual-stat__art"
                    fallbackClassName="profile-visual-stat__art-fallback"
                    disableNowPlayingStyle
                  />
                ) : (
                  <span className="profile-visual-stat__art-fallback"><Clock /></span>
                )}
                <span className="profile-visual-stat__icon"><Clock /></span>
              </div>
              <strong>{recentlyPlayed.length}</strong>
              <span>Recent songs</span>
            </div>

            <div className="profile-visual-stat">
              <div className="profile-visual-stat__media profile-visual-stat__media--icon" aria-hidden="true">
                <ListMusic />
              </div>
              <strong>{queueLength}</strong>
              <span>Queued songs</span>
            </div>

            <div className="profile-visual-stat">
              <div className="profile-visual-stat__media profile-visual-stat__media--icon" aria-hidden="true">
                <CalendarDays />
              </div>
              <strong>{totalPlays}</strong>
              <span>Tracked plays</span>
            </div>
          </section>

          <section className="profile-habits-visual" aria-label="Listening habits">
            <div className="profile-section-heading">
              <p className="eyebrow">Listening habits</p>
              <h3>Heavy rotation</h3>
            </div>

            {habitPeriods.length ? habitPeriods.map(([period, entries]) => (
              <div key={period} className="profile-habits-visual__period">
                <h4>{periodLabels[period] ?? period}</h4>

                <div className="profile-habits-visual__items">
                  {entries.slice(0, 8).map((entry, index) => {
                    const artworkSong = pickHabitArtworkSong(entry, artworkPool, index);

                    return (
                      <button
                        key={`${period}:${entry.label}`}
                        type="button"
                        className="profile-habits-visual__item"
                        onClick={() => {
                          if (artworkSong) {
                            onOpenDetails(artworkSong);
                          }
                        }}
                        disabled={!artworkSong}
                      >
                        {artworkSong ? (
                          <SongArtwork
                            song={artworkSong}
                            wrapClassName="profile-habits-visual__art"
                            fallbackClassName="profile-habits-visual__art-fallback"
                            disableNowPlayingStyle
                          />
                        ) : (
                          <span className="profile-habits-visual__art-fallback" aria-hidden="true" />
                        )}

                        <span className="profile-habits-visual__copy">
                          <strong>{entry.label}</strong>
                          <span>{entry.count} play(s), {formatSeconds(entry.totalDurationSeconds)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )) : (
              <p>No listening habits yet. Play songs while signed in to build this profile.</p>
            )}
          </section>
        </aside>
      </div>

      <section>
        <h3>Private Drive exports</h3>
        <p>
          Export listening habits as JSON to your configured private Google Drive
          folder. This uses the backend service account JSON.
        </p>

        <div className="profile-export-actions">
          <button type="button" onClick={() => void testDriveWrite()}>
            <DownloadCloud aria-hidden="true" /> Test Drive write
          </button>

          <button type="button" onClick={() => void exportHabits({ variables: { period: "WEEK" } })}>
            Export this week
          </button>

          <button type="button" onClick={() => void exportHabits({ variables: { period: "ALL" } })}>
            Export all
          </button>
        </div>

        {testResult.loading || exportResult.loading ? <p>Working...</p> : null}

        {latestExport ? (
          <div className={latestExport.ok ? "profile-export-result profile-export-result--ok" : "profile-export-result profile-export-result--error"}>
            <strong>{latestExport.ok ? "Success" : "Failed"}</strong>
            <p>{latestExport.message}</p>

            {latestExport.webViewLink ? (
              <a href={latestExport.webViewLink} target="_blank" rel="noreferrer">
                Open created file
              </a>
            ) : null}
          </div>
        ) : null}
      </section>

      <ListeningArchivePanel />
    </article>
  );
}
