import { ApolloClient, InMemoryCache, gql } from "@apollo/client";

export const apolloClient = new ApolloClient({
  uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:3000/graphql",
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
