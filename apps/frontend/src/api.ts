import {
  ApolloClient,
  InMemoryCache,
  createHttpLink,
  gql
} from "@apollo/client";
import { setContext } from "@apollo/client/link/context";
import { persistCache, LocalStorageWrapper } from "apollo3-cache-persist";

const httpLink = createHttpLink({
  uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:3000/graphql"
});

const authLink = setContext((_, { headers }) => {
  const token = window.localStorage.getItem("wavestack:auth-token");

  return {
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  };
});

export const apolloCache = new InMemoryCache({
  typePolicies: {
    Query: {
      fields: {
        songPage: {
          keyArgs: ["query"],
          merge(existing, incoming) {
            if (!existing) return incoming;
            const existingNodes = existing.nodes ?? [];
            const incomingNodes = incoming.nodes ?? [];
            const merged = [...existingNodes, ...incomingNodes];
            const seen = new Set<string>();
            const deduped = merged.filter((n) => {
              if (seen.has(n.__ref)) return false;
              seen.add(n.__ref);
              return true;
            });
            return {
              ...incoming,
              nodes: deduped
            };
          }
        }
      }
    }
  }
});

export const apolloClient = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: apolloCache,
  defaultOptions: {
    watchQuery: {
      fetchPolicy: "cache-and-network",
      nextFetchPolicy: "cache-first"
    },
    query: {
      fetchPolicy: "cache-first"
    }
  }
});

export async function restoreApolloCache(): Promise<void> {
  await persistCache({
    cache: apolloCache as unknown as Parameters<typeof persistCache>[0]["cache"],
    storage: new LocalStorageWrapper(window.localStorage),
    key: "wavestack:apollo-cache",
    maxSize: 6 * 1024 * 1024
  });
}

const SONG_CARD_FIELDS = gql`
  fragment SongCardFields on Song {
    id
    title
    artistName
    albumTitle
    durationSeconds
    streamUrl
    genreNames
    score
    thumbnailUrl
    localThumbnailUrl
    driveThumbnailUrl
    embeddedArtworkUrl
    sizeBytes
  }
`;

const SONG_DETAIL_FIELDS = gql`
  fragment SongDetailFields on Song {
    id
    title
    artistName
    albumTitle
    durationSeconds
    streamUrl
    genreNames
    score
    thumbnailUrl
    localThumbnailUrl
    driveThumbnailUrl
    embeddedArtworkUrl
    lyrics
    webViewLink
    mimeType
    modifiedTime
    sizeBytes
    sourceRootFolderId
  }
`;

export const MUSIC_HOME_QUERY = gql`
  ${SONG_CARD_FIELDS}

  query MusicHome {
    dashboardSongs(limit: 40) {
      ...SongCardFields
    }
    playlists {
      id
      name
      songCount
    }
    recentlyPlayed {
      ...SongCardFields
    }
    recommendations {
      ...SongCardFields
    }
    driveSyncStatus {
      status
      startedAt
      finishedAt
      scannedCount
      upsertedCount
      thumbnailCount
      errorMessage
    }
  }
`;

export const SONG_PAGE_QUERY = gql`
  ${SONG_CARD_FIELDS}

  query SongPage($first: Int, $after: String, $query: String) {
    songPage(first: $first, after: $after, query: $query) {
      nodes {
        ...SongCardFields
      }
      pageInfo {
        endCursor
        hasNextPage
      }
      totalCount
    }
  }
`;

export const SONG_DETAILS_QUERY = gql`
  ${SONG_DETAIL_FIELDS}

  query SongDetails($id: String!) {
    songDetails(id: $id) {
      ...SongDetailFields
    }
  }
`;

export const SYNC_DRIVE_LIBRARY_MUTATION = gql`
  mutation SyncDriveLibrary {
    syncDriveLibrary {
      ok
      message
      scannedCount
      upsertedCount
      thumbnailCount
    }
  }
`;

export const ME_QUERY = gql`
  query Me {
    me {
      id
      email
      displayName
      avatarUrl
    }
  }
`;

export const RECORD_LISTEN_MUTATION = gql`
  mutation RecordListen(
    $songId: String!,
    $artistName: String!,
    $title: String!,
    $durationSeconds: Int!,
    $completedPlayRatio: Float!
  ) {
    recordListen(
      songId: $songId,
      artistName: $artistName,
      title: $title,
      durationSeconds: $durationSeconds,
      completedPlayRatio: $completedPlayRatio
    )
  }
`;

export const RECOMMENDED_SONGS_QUERY = gql`
  ${SONG_CARD_FIELDS}

  query RecommendedSongs($limit: Int, $offset: Int, $favoriteSongIds: [String!], $recentSongIds: [String!], $excludedSongIds: [String!]) {
    recommendedSongs(limit: $limit, offset: $offset, favoriteSongIds: $favoriteSongIds, recentSongIds: $recentSongIds, excludedSongIds: $excludedSongIds) {
      nodes {
        song {
          ...SongCardFields
        }
        reason
      }
      totalCount
      hasNextPage
      nextOffset
    }
  }
`;

export const LISTENING_HABIT_SUMMARY_QUERY = gql`
  query ListeningHabitSummary($period: String!) {
    listeningHabitSummary(period: $period) {
      label
      count
      totalDurationSeconds
    }
  }
`;

export const TOP_TRACKS_QUERY = gql`
  query TopTracks($period: String!, $limit: Int) {
    topTracks(period: $period, limit: $limit) {
      key
      label
      subtitle
      rank
      previousRank
      rankChange
      playCount
      totalDurationSeconds
      songId
      thumbnailUrl
    }
  }
`;

export const TOP_ARTISTS_QUERY = gql`
  query TopArtists($period: String!, $limit: Int) {
    topArtists(period: $period, limit: $limit) {
      key
      label
      subtitle
      rank
      previousRank
      rankChange
      playCount
      totalDurationSeconds
      thumbnailUrl
    }
  }
`;

export const TOP_GENRES_QUERY = gql`
  query TopGenres($period: String!, $limit: Int) {
    topGenres(period: $period, limit: $limit) {
      key
      label
      subtitle
      rank
      previousRank
      rankChange
      playCount
      totalDurationSeconds
    }
  }
`;

export const RECENTLY_PLAYED_DETAILED_QUERY = gql`
  query RecentlyPlayedDetailed($period: String!, $limit: Int) {
    recentlyPlayedDetailed(period: $period, limit: $limit) {
      songId
      title
      artistName
      durationSeconds
      completedPlayRatio
      startedAt
    }
  }
`;

export const SAVE_STATS_SNAPSHOT_MUTATION = gql`
  mutation SaveStatsSnapshot($statType: String!, $period: String!, $label: String!) {
    saveStatsSnapshot(statType: $statType, period: $period, label: $label) {
      id
      statType
      period
      label
      generatedAt
      entries {
        key
        label
        subtitle
        rank
        previousRank
        rankChange
        playCount
        totalDurationSeconds
        songId
        thumbnailUrl
      }
    }
  }
`;

export const PREVIOUS_STATS_SNAPSHOTS_QUERY = gql`
  query PreviousStatsSnapshots {
    previousStatsSnapshots {
      id
      statType
      period
      label
      generatedAt
      entries {
        key
        label
        subtitle
        rank
        previousRank
        rankChange
        playCount
        totalDurationSeconds
        songId
        thumbnailUrl
      }
    }
  }
`;

export const PLACEMENT_HISTORY_QUERY = gql`
  query PlacementHistory($key: String!) {
    placementHistory(key: $key) {
      snapshotId
      generatedAt
      rank
    }
  }
`;

export const TEST_PRIVATE_DRIVE_WRITE_MUTATION = gql`
  mutation TestPrivateDriveWrite {
    testPrivateDriveWrite {
      ok
      message
      folderId
      webViewLink
    }
  }
`;

export const EXPORT_LISTENING_HABITS_MUTATION = gql`
  mutation ExportListeningHabits($period: String) {
    exportListeningHabits(period: $period) {
      ok
      message
      webViewLink
    }
  }
`;

export const LISTENING_STATS_ENTRY_FIELDS = gql`
  fragment ListeningStatsEntryFields on ListeningStatsEntry {
    key
    label
    subtitle
    rank
    previousRank
    rankChange
    playCount
    totalDurationSeconds
    songId
    thumbnailUrl
  }
`;

export const TASTE_COMPARISON_QUERY = gql`
  ${LISTENING_STATS_ENTRY_FIELDS}

  query TasteComparison($period: String) {
    tasteComparison(period: $period) {
      userPlayCount
      libraryUserCount
      obscurityScore
      mainstreamScore
      uniquenessScore
      overlapScore
      rareArtists {
        ...ListeningStatsEntryFields
      }
      commonArtists {
        ...ListeningStatsEntryFields
      }
    }
  }
`;

export const JUDGE_TASTE_MUTATION = gql`
  mutation JudgeTaste($period: String) {
    judgeTaste(period: $period) {
      ok
      verdictTitle
      roast
      summary
      badges
      tasteScore
      obscurityScore
      chaosScore
      generatedAt
    }
  }
`;

export const GROQ_DEBUG_STATUS_QUERY = gql`
  query GroqDebugStatus {
    groqDebugStatus {
      model
      configuredKeyCount
      configuredKeyNames
    }
  }
`;

export const LISTENING_ARCHIVE_STATUS_QUERY = gql`
  query ListeningArchiveStatus {
    listeningArchiveStatus {
      rawEventCount
      archivedRollupRowCount
      archiveRunCount
      oldestRawEventAt
      latestArchiveRunAt
      latestArchiveStatus
      latestArchiveMessage
    }
  }
`;

export const ARCHIVE_OLD_LISTENING_EVENTS_MUTATION = gql`
  mutation ArchiveOldListeningEvents($daysToKeep: Int, $dryRun: Boolean) {
    archiveOldListeningEvents(daysToKeep: $daysToKeep, dryRun: $dryRun) {
      ok
      message
      exportedEventCount
      deletedEventCount
      driveFileCount
      cutoffAt
      driveFolderId
      runId
      errorMessage
    }
  }
`;

export const REPAIR_EMBEDDED_LYRICS_FOR_SONG_MUTATION = gql`
  mutation RepairEmbeddedLyricsForSong($songId: String!) {
    repairEmbeddedLyricsForSong(songId: $songId) {
      ok
      message
      attemptedCount
      repairedCount
      failedCount
    }
  }
`;

export const LIBRARY_STATE_QUERY = gql`
  ${SONG_CARD_FIELDS}

  query LibraryState {
    libraryState {
      favorites {
        ...SongCardFields
      }
      recentlyPlayed {
        ...SongCardFields
      }
      playlists {
        id
        name
        songCount
        songIds
        songs {
          ...SongCardFields
        }
        createdAt
        updatedAt
      }
    }
  }
`;

export const FAVORITE_SONG_MUTATION = gql`
  ${SONG_CARD_FIELDS}

  mutation FavoriteSong($songId: String!) {
    favoriteSong(songId: $songId) {
      ...SongCardFields
    }
  }
`;

export const UNFAVORITE_SONG_MUTATION = gql`
  ${SONG_CARD_FIELDS}

  mutation UnfavoriteSong($songId: String!) {
    unfavoriteSong(songId: $songId) {
      ...SongCardFields
    }
  }
`;

export const CREATE_USER_PLAYLIST_MUTATION = gql`
  ${SONG_CARD_FIELDS}

  mutation CreateUserPlaylist($name: String!) {
    createUserPlaylist(name: $name) {
      id
      name
      songCount
      songIds
      songs {
        ...SongCardFields
      }
      createdAt
      updatedAt
    }
  }
`;

export const DELETE_USER_PLAYLIST_MUTATION = gql`
  ${SONG_CARD_FIELDS}

  mutation DeleteUserPlaylist($playlistId: String!) {
    deleteUserPlaylist(playlistId: $playlistId) {
      id
      name
      songCount
      songIds
      songs {
        ...SongCardFields
      }
      createdAt
      updatedAt
    }
  }
`;

export const ADD_SONG_TO_USER_PLAYLIST_MUTATION = gql`
  ${SONG_CARD_FIELDS}

  mutation AddSongToUserPlaylist($playlistId: String!, $songId: String!) {
    addSongToUserPlaylist(playlistId: $playlistId, songId: $songId) {
      id
      name
      songCount
      songIds
      songs {
        ...SongCardFields
      }
      createdAt
      updatedAt
    }
  }
`;

export const REMOVE_SONG_FROM_USER_PLAYLIST_MUTATION = gql`
  ${SONG_CARD_FIELDS}

  mutation RemoveSongFromUserPlaylist($playlistId: String!, $songId: String!) {
    removeSongFromUserPlaylist(playlistId: $playlistId, songId: $songId) {
      id
      name
      songCount
      songIds
      songs {
        ...SongCardFields
      }
      createdAt
      updatedAt
    }
  }
`;
