param(
    [Parameter(Mandatory = $true)]
    [string]$PostgresHost,

    [Parameter(Mandatory = $true)]
    [string]$DatabaseName,

    [Parameter(Mandatory = $true)]
    [string]$UserName,

    [Parameter(Mandatory = $true)]
    [string]$StorageAccountName,

    [Parameter(Mandatory = $true)]
    [string]$StorageContainerName,

    [string]$OutputDirectory = "$PSScriptRoot/../../tmp/backups"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = Join-Path $OutputDirectory "$DatabaseName-$timestamp.dump"

pg_dump --host $PostgresHost --username $UserName --format custom --file $backupPath $DatabaseName

az storage blob upload `
    --account-name $StorageAccountName `
    --container-name $StorageContainerName `
    --name "postgres/$DatabaseName-$timestamp.dump" `
    --file $backupPath `
    --overwrite

Write-Host "Backup created: $backupPath"
