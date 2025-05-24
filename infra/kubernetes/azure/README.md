# Azure Kubernetes Deployment

The Azure overlay is reserved for AKS-specific settings:

- Azure Container Registry image names
- Azure Key Vault backed secrets
- Azure Blob Storage credentials
- Managed PostgreSQL endpoints
- Internal TLS certificates for service-to-service traffic

Start with `../base` for local clusters, then add an overlay here when the AKS resource names are final.
