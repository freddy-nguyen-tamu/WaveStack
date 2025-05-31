# Azure Virtual Machine Use

The Azure Bicep template includes a Linux virtual machine because infrastructure projects sometimes need a non-Kubernetes node for:

- Simulating a multi-node deployment environment
- Running load generation outside AKS
- Testing backup and restore workflows
- Hosting temporary admin tooling
- Demonstrating VM-level orchestration alongside Kubernetes

The VM is not required for normal application traffic. AKS remains the primary runtime for WaveStack services.
