# PKI And Signed Streaming URLs

WaveStack uses two complementary security patterns:

1. Signed streaming URLs for user playback.
2. Certificate-based internal service communication for private service calls.

## Signed URL Flow

1. A user asks the GraphQL API to play a song.
2. The API checks authorization through PostgreSQL playlist, favorite, or ownership records.
3. The API creates a short-lived URL signature using `SIGNED_URL_SECRET`.
4. The frontend streams the music file or HLS manifest before the token expires.
5. Stream token hashes are recorded in PostgreSQL for audit and abuse detection.

The starter implementation lives in `services/graphql-api/src/storage/signed-url.service.ts`.

## Internal Certificates

Use `scripts/powershell/New-InternalCertificate.ps1` to generate development certificates. Production certificates should be issued by Azure Key Vault, cert-manager, or an internal CA and mounted into Kubernetes secrets.

Recommended service identities:

- graphql-api.wavestack.internal
- audio-ai-service.wavestack.internal
- analytics-service.wavestack.internal
- rabbitmq.wavestack.internal
