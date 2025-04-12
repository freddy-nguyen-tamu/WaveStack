# WaveStack

WaveStack is a cloud-native music streaming platform scaffold. It is set up as a multi-service system for uploading, streaming, organizing, discovering, and analyzing music.

No CSS is included yet. The frontend is intentionally plain React markup so styling can be added later without having to unwind starter theme files.

## Technology Coverage

| Area | Technology |
| --- | --- |
| Frontend | React, Vite, TypeScript, Vitest |
| GraphQL API | NestJS, GraphQL, Jest |
| Relational data | PostgreSQL |
| Graph data | Neo4j |
| Background jobs | RabbitMQ |
| Audio and AI service | Python, FastAPI, Pytest |
| Analytics service | C#/.NET, xUnit |
| Containers | Docker, Docker Compose |
| Orchestration | Kubernetes |
| Cloud | Azure, AKS, Azure Container Registry, Azure Database for PostgreSQL, Azure Storage, Key Vault, Virtual Machine |
| Automation | PowerShell scripts |
| Security | PKI notes, certificate bootstrap script, signed streaming URLs |
| Coverage | Jest, Vitest, Pytest, xUnit coverage dashboard plan |

## System Shape

```txt
React Frontend
      |
      v
NestJS GraphQL API
      |
      |---- PostgreSQL
      |---- Neo4j
      |---- RabbitMQ
      |---- Python FastAPI Audio/AI Service
      |---- C#/.NET Analytics Service
      |---- Azure Blob Storage compatible music storage
```

## Project Layout

```txt
apps/frontend                     React + Vite + TypeScript music UI
services/graphql-api              NestJS + GraphQL API gateway
services/audio-ai-service          Python FastAPI audio processing and recommendation service
services/analytics-service         C#/.NET analytics and admin metrics service
infra/postgres                     PostgreSQL schema migrations
infra/neo4j                        Neo4j recommendation graph model
infra/rabbitmq                     RabbitMQ definitions
infra/docker                       Docker Compose support files
infra/kubernetes                   Kubernetes manifests
infra/azure                        Azure Bicep infrastructure
infra/pki                          PKI and signed URL notes
scripts/powershell                 Azure, backup, Kubernetes, and certificate scripts
tests/integration                  Cross-service integration test placeholders
coverage-dashboard                 Combined coverage dashboard scaffold
```

## Roadmap

1. Basic React music player
2. User authentication
3. Song upload
4. PostgreSQL schema
5. Playlist system
6. GraphQL API
7. RabbitMQ background audio jobs
8. Python audio metadata and AI service
9. Dockerize everything
10. Kubernetes deployment
11. Azure infrastructure
12. C# analytics dashboard
13. Neo4j recommendation graph
14. PKI and signed streaming URLs
15. Automated tests and coverage dashboard

## Resume Description

Architected WaveStack, a cloud-native music streaming platform with a React and TypeScript frontend, NestJS GraphQL API, PostgreSQL and Neo4j data layers, RabbitMQ-powered audio processing pipeline, Python FastAPI AI service, C#/.NET analytics service, signed streaming URLs, and containerized microservices deployable through Docker, Kubernetes, and Azure.
