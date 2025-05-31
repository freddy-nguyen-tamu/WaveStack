param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string]$Location,

    [Parameter(Mandatory = $true)]
    [securestring]$PostgresAdminPassword,

    [Parameter(Mandatory = $true)]
    [string]$VmSshPublicKey,

    [string]$EnvironmentName = "dev"
)

$ErrorActionPreference = "Stop"

az group create --name $ResourceGroupName --location $Location | Out-Null

$plainPostgresPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PostgresAdminPassword)
)

az deployment group create `
    --resource-group $ResourceGroupName `
    --template-file "$PSScriptRoot/../../infra/azure/bicep/main.bicep" `
    --parameters `
        environmentName=$EnvironmentName `
        postgresAdminPassword=$plainPostgresPassword `
        vmSshPublicKey="$VmSshPublicKey"

$aksName = "wavestack-$EnvironmentName-aks"
az aks get-credentials --resource-group $ResourceGroupName --name $aksName --overwrite-existing
kubectl apply -k "$PSScriptRoot/../../infra/kubernetes/base"
