import { CalendarDays, Clock, DownloadCloud, Heart, ListMusic, UserCircle } from "lucide-react";
import { useMutation } from "@apollo/client";
import type { AuthUser, ClientPlaylist, HabitSummaryEntry, Song } from "../../App";
import { EXPORT_LISTENING_HABITS_MUTATION, TEST_PRIVATE_DRIVE_WRITE_MUTATION } from "../../api";
import { formatSeconds, formatSongDisplayName } from "../../song-format";
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
  favorites: Song[];
  recentlyPlayed: Song[];
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  queueLength: number;
  habitSummaries: Record<string, HabitSummaryEntry[]>;
  onLogout: () => void;
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onOpenDetails: (song: Song) => void;
};

const periodLabels: Record<string, string> = {
  DAY: "Today",
  WEEK: "This week",
  MONTH: "This month",
  YEAR: "This year"
};

export function ProfilePage({
  user,
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

      <section className="profile-stats" aria-label="Profile stats">
        <div>
          <Heart aria-hidden="true" />
          <strong>{favorites.length}</strong>
          <span>Favorites</span>
        </div>

        <div>
          <Clock aria-hidden="true" />
          <strong>{recentlyPlayed.length}</strong>
          <span>Recent songs</span>
        </div>

        <div>
          <ListMusic aria-hidden="true" />
          <strong>{queueLength}</strong>
          <span>Queued songs</span>
        </div>

        <div>
          <CalendarDays aria-hidden="true" />
          <strong>{totalPlays}</strong>
          <span>Tracked plays</span>
        </div>
      </section>

      <section>
        <h3>Listening habits</h3>

        {Object.keys(habitSummaries).length ? (
          <div className="habit-grid">
            {Object.entries(habitSummaries).map(([period, entries]) => (
              <div key={period} className="habit-card">
                <h3>{periodLabels[period] ?? period}</h3>

                {entries.length ? (
                  entries.slice(0, 8).map((entry) => (
                    <div key={entry.label} className="habit-card__row">
                      <span className="habit-card__label">{entry.label}</span>
                      <span className="habit-card__count">
                        {entry.count} play(s), {formatSeconds(entry.totalDurationSeconds)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p>No plays tracked for this period yet.</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p>No listening habits yet. Play songs while signed in to build this profile.</p>
        )}
      </section>

      <section>
        <h3>Recently played</h3>

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
                  onOpenDetails={onOpenDetails}
                />
                <SongActions
                  song={song}
                  playlists={playlists}
                  isFavorite={favoriteIds.includes(song.id)}
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
