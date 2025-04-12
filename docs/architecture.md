# WaveStack Architecture

WaveStack is designed as a cloud-native music streaming platform. The frontend owns playback and user workflows. The GraphQL API coordinates metadata, authorization, search, playback history, favorites, playlist updates, signed streaming URLs, and background job dispatch.

## Services

| Service | Role |
| --- | --- |
| Frontend | React, Vite, TypeScript music UI with player, playlists, queue, search, dashboard, favorites, and recently played sections |
| GraphQL API | NestJS API gateway for users, songs, albums, playlists, search, playback history, recommendations, uploads, and signed URLs |
| PostgreSQL | System of record for users, songs, artists, albums, playlists, listening history, favorites, upload jobs, and stream token audit records |
| Neo4j | Relationship graph for recommendations across users, artists, songs, genres, playlists, and listening behavior |
| RabbitMQ | Async messaging for audio processing, waveform generation, recommendation updates, and playlist share notifications |
| Audio AI Service | Python FastAPI service for duration extraction, metadata, waveform data, conversion hooks, tempo, genre, mood, and recommendation model training |
| Analytics Service | C#/.NET service for play counts, trending songs, admin reports, and internal metrics |
| Azure Storage | Private object storage for uploaded music, transcoded streams, waveform previews, and cover art |

## Deployment

Each service has a Dockerfile and can be scheduled on Kubernetes. Azure Bicep provisions AKS, ACR, PostgreSQL, Storage, Key Vault, and a Linux VM for infrastructure experiments or multi-node simulation.
