import { ApolloClient, InMemoryCache, gql } from "@apollo/client";

export const apolloClient = new ApolloClient({
  uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:3000/graphql",
  cache: new InMemoryCache()
});

export const MUSIC_HOME_QUERY = gql`
  query MusicHome {
    songs {
      id
      title
      artistName
      albumTitle
      durationSeconds
      streamUrl
      genreNames
    }
    playlists {
      id
      name
      songCount
    }
    recentlyPlayed {
      id
      title
      artistName
    }
    recommendations {
      id
      title
      artistName
      score
    }
  }
`;
