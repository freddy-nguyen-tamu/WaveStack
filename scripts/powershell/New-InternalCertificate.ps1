param(
    [string]$OutputDirectory = "$PSScriptRoot/../../infra/pki/dev-certs",
    [string[]]$DnsNames = @(
        "graphql-api.wavestack.internal",
        "audio-ai-service.wavestack.internal",
        "analytics-service.wavestack.internal",
        "rabbitmq.wavestack.internal"
    )
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$root = New-SelfSignedCertificate `
    -Type Custom `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -Subject "CN=WaveStack Dev Root CA" `
    -KeyAlgorithm RSA `
    -KeyLength 4096 `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(5)

foreach ($dnsName in $DnsNames) {
    $cert = New-SelfSignedCertificate `
        -Type SSLServerAuthentication `
        -DnsName $dnsName `
        -Signer $root `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -NotAfter (Get-Date).AddYears(1)

    $safeName = $dnsName.Replace(".", "-")
    Export-Certificate -Cert $cert -FilePath (Join-Path $OutputDirectory "$safeName.crt") | Out-Null
    Export-PfxCertificate -Cert $cert -FilePath (Join-Path $OutputDirectory "$safeName.pfx") -Password (ConvertTo-SecureString "dev-password" -AsPlainText -Force) | Out-Null
}

Export-Certificate -Cert $root -FilePath (Join-Path $OutputDirectory "wavestack-dev-root-ca.crt") | Out-Null
Write-Host "Development certificates written to $OutputDirectory"
