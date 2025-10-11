import { ApolloClient, InMemoryCache, gql, createHttpLink } from "@apollo/client";
import { setContext } from "@apollo/client/link/context";

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

export const apolloClient = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache()
});

const SONG_FIELDS = gql`
  fragment SongFields on Song {
    id
    title
    artistName
    albumTitle
    durationSeconds
    streamUrl
    genreNames
    score
    thumbnailUrl
    lyrics
    webViewLink
    mimeType
    modifiedTime
    sizeBytes
    sourceRootFolderId
  }
`;

export const MUSIC_HOME_QUERY = gql`
  ${SONG_FIELDS}

  query MusicHome {
    songs {
      ...SongFields
    }
    playlists {
      id
      name
      songCount
    }
    recentlyPlayed {
      ...SongFields
    }
    recommendations {
      ...SongFields
    }
  }
`;

export const LOGIN_MUTATION = gql`
  mutation Login($email: String!, $password: String!) {
    login(email: $email, password: $password) {
      token
      user {
        id
        email
        displayName
        createdAt
      }
    }
  }
`;

export const REGISTER_MUTATION = gql`
  mutation Register($email: String!, $displayName: String!, $password: String!) {
    register(email: $email, displayName: $displayName, password: $password) {
      token
      user {
        id
        email
        displayName
        createdAt
      }
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
  ${SONG_FIELDS}

  query RecommendedSongs($limit: Int) {
    recommendedSongs(limit: $limit) {
      song {
        ...SongFields
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
