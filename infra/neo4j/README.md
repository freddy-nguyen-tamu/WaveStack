# Neo4j Recommendation Graph

Neo4j models relationships that are awkward to express as plain relational joins:

- users listen to songs
- users favorite songs
- users own playlists
- playlists contain songs
- songs are created by artists
- songs map to genres
- songs are similar by genre, tempo, mood, and co-listening behavior

The starter Cypher file creates graph constraints and a sample recommendation query. The GraphQL API can write relationship events after PostgreSQL commits, or a RabbitMQ consumer can project listening events into Neo4j asynchronously.
