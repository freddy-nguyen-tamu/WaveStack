# Security

WaveStack includes starter security hooks for a streaming platform:

- Signed streaming URLs keep music files private while allowing short-lived playback.
- PostgreSQL `stream_tokens` records support audit and abuse investigation.
- Azure Storage should keep music containers private.
- Azure Key Vault should hold `SIGNED_URL_SECRET`, database passwords, and certificate material.
- Internal service communication can use certificates generated through a development PKI or issued by a production CA.
- Kubernetes secrets should be replaced with Key Vault or sealed secret integration before production.
