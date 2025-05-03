CREATE CONSTRAINT user_id IF NOT EXISTS FOR (user:User) REQUIRE user.id IS UNIQUE;
CREATE CONSTRAINT song_id IF NOT EXISTS FOR (song:Song) REQUIRE song.id IS UNIQUE;
CREATE CONSTRAINT artist_id IF NOT EXISTS FOR (artist:Artist) REQUIRE artist.id IS UNIQUE;
CREATE CONSTRAINT playlist_id IF NOT EXISTS FOR (playlist:Playlist) REQUIRE playlist.id IS UNIQUE;
CREATE CONSTRAINT genre_name IF NOT EXISTS FOR (genre:Genre) REQUIRE genre.name IS UNIQUE;

MERGE (user:User {id: "user-1", displayName: "WaveStack Listener"});
MERGE (artist:Artist {id: "artist-1", name: "The Latency"});
MERGE (song:Song {id: "song-1", title: "Cloudline", tempoBpm: 116});
MERGE (genre:Genre {name: "electronic"});
MERGE (playlist:Playlist {id: "playlist-1", name: "Morning Deploys"});

MERGE (artist)-[:CREATED]->(song);
MERGE (song)-[:HAS_GENRE]->(genre);
MERGE (user)-[:LISTENED_TO {completedPlayRatio: 0.94, playCount: 7}]->(song);
MERGE (user)-[:LIKES]->(song);
MERGE (playlist)-[:CONTAINS {position: 1}]->(song);
MERGE (user)-[:OWNS]->(playlist);

MATCH (user:User {id: $userId})-[:LISTENED_TO|LIKES]->(:Song)-[:HAS_GENRE]->(genre:Genre)<-[:HAS_GENRE]-(candidate:Song)
WHERE NOT (user)-[:LISTENED_TO]->(candidate)
RETURN candidate.id AS songId, candidate.title AS title, count(genre) AS genreOverlap
ORDER BY genreOverlap DESC
LIMIT 25;
