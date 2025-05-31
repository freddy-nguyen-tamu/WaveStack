# Azure

The Bicep template provisions the main Azure footprint:

- Azure Kubernetes Service for container orchestration
- Azure Container Registry for service images
- Azure Database for PostgreSQL Flexible Server
- Azure Storage for private music objects and stream manifests
- Azure Key Vault for signed URL secrets and certificate material
- Azure Virtual Machine for infrastructure experiments or simulated multi-node orchestration

PowerShell scripts under `scripts/powershell` wrap common deployment and administration commands.
