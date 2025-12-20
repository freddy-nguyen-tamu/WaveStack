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
            return {
              ...incoming,
              nodes: [...(existing.nodes ?? []), ...(incoming.nodes ?? [])]
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

  query RecommendedSongs($limit: Int, $favoriteSongIds: [String!], $recentSongIds: [String!]) {
    recommendedSongs(limit: $limit, favoriteSongIds: $favoriteSongIds, recentSongIds: $recentSongIds) {
      song {
        ...SongCardFields
      }
      reason
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

export const TEST_PRIVATE_DRIVE_WRITE_MUTATION = gql`
  mutation TestPrivateDriveWrite {
    testPrivateDriveWrite {
      ok
      message
      folderId
      credentialsPath
      fileId
      webViewLink
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

export const EXPORT_LISTENING_HABITS_MUTATION = gql`
  mutation ExportListeningHabits($period: String) {
    exportListeningHabits(period: $period) {
      ok
      message
      fileId
      webViewLink
    }
  }
`;
