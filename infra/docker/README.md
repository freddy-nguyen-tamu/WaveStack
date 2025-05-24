# Docker

The root `docker-compose.yml` runs the WaveStack services together:

- React frontend
- NestJS GraphQL API
- Python FastAPI audio and AI service
- C#/.NET analytics service
- PostgreSQL
- Neo4j
- RabbitMQ
- Azurite for local Azure Blob Storage style development

Each application service owns its Dockerfile so the Kubernetes manifests can point at independently built images.
