param(
  [string]$SourceUrl = '',
  [string]$SourceHtml = '',
  [switch]$Authorized,
  [switch]$ShutdownWhenDone,
  [switch]$NoShutdownPrompt
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# All prerequisite acquisition is performed here. No Git config/credential store
# belonging to unrelated tools is changed. Tool PATH changes are PROCESS-LOCAL.
# If Git Credential Manager is unavailable, use a PRIVATE portable Git for Windows
# distribution in .archiver_tools (not a system-level Git installer).
$ToolsRoot = Join-Path $PSScriptRoot '.archiver_tools'
New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null

function Update-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $node = Join-Path $env:ProgramFiles 'nodejs'
  $py13 = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313'
  $env:Path = (@($env:Path, $machine, $user, $node, $py13, (Join-Path $py13 'Scripts')) |
      Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function Install-WingetPackage([string]$PackageId) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "Windows Package Manager (winget) is required to install $PackageId automatically. Install App Installer from Microsoft Store and rerun."
  }
  Write-Host "Installing missing prerequisite: $PackageId" -ForegroundColor Cyan
  & winget.exe install --id $PackageId --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "winget could not install $PackageId (exit code $LASTEXITCODE)." }
  Update-ProcessPath
}

Update-ProcessPath
$pythonOK = $false
if (Get-Command python.exe -ErrorAction SilentlyContinue) {
  & python.exe -c 'import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>$null
  $pythonOK = ($LASTEXITCODE -eq 0)
}
if (-not $pythonOK) {
  Install-WingetPackage 'Python.Python.3.13'
  $candidates = @((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'),
                  (Join-Path $env:ProgramFiles 'Python313\python.exe'))
  $candidate = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($candidate) { $env:Path = "$(Split-Path -Parent $candidate);$env:Path" }
  if (-not (Get-Command python.exe -ErrorAction SilentlyContinue)) {
    throw 'Python was installed but could not be found. Open a new CMD window and rerun this script.'
  }
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue) -or
    -not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  Install-WingetPackage 'OpenJS.NodeJS.LTS'
  $env:Path = "$(Join-Path $env:ProgramFiles 'nodejs');$env:Path"
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue) -or
      -not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw 'Node.js/npm installed but not detected. Open a fresh CMD window and rerun this script.'
  }
}

function Get-CompatibleGit {
  # Prefer a tool that is already installed, but only READ its binaries.
  # Do not invoke its global configuration or change its credential helper.
  $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
  $roots = New-Object System.Collections.Generic.List[string]
  $managed = Join-Path $ToolsRoot 'PortableGit'
  $roots.Add($managed)
  if ($gitCommand) {
    $gitFull = $gitCommand.Source
    $roots.Add((Split-Path (Split-Path $gitFull -Parent) -Parent))
  }
  if ($env:ProgramFiles) { $roots.Add((Join-Path $env:ProgramFiles 'Git')) }
  if ($env:LOCALAPPDATA) { $roots.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git')) }
  foreach ($root in ($roots | Select-Object -Unique)) {
    $exe = Join-Path $root 'cmd\git.exe'
    if (-not (Test-Path $exe)) { continue }
    foreach ($folder in @('ucrt64\bin','mingw64\bin','clangarm64\bin')) {
      $helperDir = Join-Path $root $folder
      $gcm = Join-Path $helperDir 'git-credential-manager.exe'
      if (Test-Path $gcm) {
        $env:Path = "$(Join-Path $root 'cmd');$helperDir;$env:Path"
        Write-Host "Using Git/GCM from $root" -ForegroundColor DarkGray
        return $true
      }
    }
  }
  return $false
}

if (-not (Get-CompatibleGit)) {
  Write-Host 'Git Credential Manager missing. Downloading portable Git for Windows privately for this application...' -ForegroundColor Cyan
  Write-Host 'Your existing Git installation, SSH keys, credentials, and global Git config will NOT be changed.'
  $managed = Join-Path $ToolsRoot 'PortableGit'
  $arch = $env:PROCESSOR_ARCHITECTURE
  $pattern = if ($arch -eq 'ARM64') { '^PortableGit-.*-arm64\.7z\.exe$' } else { '^PortableGit-.*-64-bit\.7z\.exe$' }
  try {
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'UniversalComicArchiverInstaller' } -TimeoutSec 45
    $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if (-not $asset) { throw "Official PortableGit asset missing for architecture $arch." }
    $archive = Join-Path $ToolsRoot $asset.name
    if (-not (Test-Path $archive)) {
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -TimeoutSec 600 -MaximumRedirection 10
    }
    New-Item -ItemType Directory -Force -Path $managed | Out-Null
    # Official Git for Windows portable 7z.exe supports -y -gm2 -InstallPath.
    $escapedPath = $managed.Replace('\','\\')
    $proc = Start-Process -FilePath $archive -ArgumentList @('-y','-gm2',('-InstallPath="' + $escapedPath + '"')) -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "Portable Git extraction failed (exit $($proc.ExitCode))." }
  } catch {
    throw "Automatic portable Git installation failed: $($_.Exception.Message). No Git configuration was modified."
  }
  if (-not (Get-CompatibleGit)) {
    throw 'Portable Git was extracted but Git Credential Manager could not be located. Please report the extracted directory listing.'
  }
}

& git.exe --version
if ($LASTEXITCODE -ne 0) { throw 'Git cannot run' }
& git-credential-manager.exe --version
if ($LASTEXITCODE -ne 0) { throw 'Git Credential Manager cannot run' }
Write-Host 'All system prerequisites are now available. Continuing with libraries, Firefox, and Wrangler.' -ForegroundColor Green

if (-not (Test-Path '.venv/Scripts/python.exe')) { & python -m venv .venv; if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed' } }
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Python dependencies failed to install' }
# Default source driver uses the computer's INSTALLED Mozilla Firefox.
# Do not download Playwright's patched Firefox (or alter personal profiles).
# Selenium Manager automatically provisions GeckoDriver on first native launch.
if (-not (Test-Path 'node_modules/.bin/wrangler.cmd')) {
  & npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Wrangler installation failed' }
}

# Ask once at startup so long unattended jobs can finish and optionally shut down.
# This NEVER initiates shutdown if any chapter is not published/verified.
if (-not $ShutdownWhenDone -and -not $NoShutdownPrompt) {
  Write-Host 'Important: Windows shutdown can close other open programs. Save your work before enabling it.' -ForegroundColor Yellow
  Write-Host ''
  $answerShutdown = Read-Host 'Shut down this computer automatically AFTER verified Cloudflare publication? [y/N]'
  if ($answerShutdown -match '^(y|yes)$') { $ShutdownWhenDone = $true }
}
if ($ShutdownWhenDone) {
  Write-Host 'Shutdown enabled ONLY after fully successful publication (60-second cancellation window).' -ForegroundColor Yellow
} else {
  Write-Host 'Shutdown disabled; program will exit normally after successful publication.'
}

Write-Host ''
Write-Host 'STEP 1/3: GITHUB WEBSITE SIGN-IN' -ForegroundColor Cyan
Write-Host 'Use the GitHub login window that opens. No HTML file or manually created token is required.'
Write-Host 'Your normal terminal GitHub configuration will NOT be changed.'
$accountStatus = (& .\.venv\Scripts\python.exe comic_archiver.py --github-account | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not read archiver GitHub account state' }
if ($accountStatus -match 'not selected') {
  & .\.venv\Scripts\python.exe comic_archiver.py --github-login
  if ($LASTEXITCODE -ne 0) { throw 'GitHub browser sign-in was not completed' }
} else {
  Write-Host $accountStatus.Trim()
  Write-Host 'Reusing the selected archiver-only GitHub account. To switch: python comic_archiver.py --github-switch-account'
}

Write-Host ''
Write-Host 'STEP 2/3: CLOUDFLARE WEBSITE SIGN-IN' -ForegroundColor Cyan
Write-Host 'Wrangler opens the official Cloudflare browser authorization page when necessary.'
$authMarker = Join-Path $PSScriptRoot '.archiver_state\cloudflare-browser-authorized.txt'
$needCloudflareLogin = -not (Test-Path $authMarker)
if (-not $needCloudflareLogin) {
  $who = (& .\node_modules\.bin\wrangler.cmd whoami 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $who -match 'not logged in|not authenticated|You are not logged in') {
    $needCloudflareLogin = $true
  }
}
if ($needCloudflareLogin) {
  & .\node_modules\.bin\wrangler.cmd login
  if ($LASTEXITCODE -ne 0) { throw 'Cloudflare browser login was not completed' }
  & .\node_modules\.bin\wrangler.cmd whoami
  if ($LASTEXITCODE -ne 0) { throw 'Could not verify Cloudflare authorization' }
  New-Item -ItemType Directory -Force -Path (Split-Path $authMarker) | Out-Null
  Set-Content -LiteralPath $authMarker -Value 'Browser authorization completed; verify again on later runs.' -Encoding UTF8
} else {
  Write-Host 'Cloudflare login is still valid; reusing the existing session.'
}

Write-Host ''
Write-Host 'STEP 3/3: OPEN COMIC WEBPAGE AND START' -ForegroundColor Cyan
# Only site_specific/site_adapter.py owns the source URL and selectors.
# Changing sites never requires editing the bootstrap or a second configuration.
if (-not $SourceUrl -and -not $SourceHtml) {
  $SourceUrl = (& .\.venv\Scripts\python.exe comic_archiver.py --default-source-url | Out-String).Trim()
}
if (-not $SourceUrl -and -not $SourceHtml) {
  $SourceUrl = (Read-Host 'Paste the normal comic reader webpage URL (no HTML file needed)').Trim()
}
$sourceArgs = @()
if ($SourceHtml) {
  if (-not (Test-Path -LiteralPath $SourceHtml)) { throw "HTML file not found: $SourceHtml" }
  $sourceArgs = @('--source-html', $SourceHtml)
  if ($SourceUrl) { $sourceArgs += @('--source-url', $SourceUrl) }
} else {
  if ($SourceUrl -notmatch '^https?://') { throw 'Comic webpage must be an http(s) URL' }
  Write-Host "Reading directly from comic webpage: $SourceUrl"
  $sourceArgs = @('--source-url', $SourceUrl)
}
if (-not $Authorized) {
  Write-Host 'Only download and publish images if you have the required permissions.'
  $ack = Read-Host 'Type I HAVE RIGHTS to confirm permission to archive and redistribute'
  if ($ack -ne 'I HAVE RIGHTS') { throw 'Permission confirmation not provided; nothing archived or published.' }
}
# Reconcile BOTH legacy and current GitHub volume manifests before opening
# any comic source tab. If all verified, skip all source traversal and scrolling.
# If partially complete, the Python engine keeps the saved chapter catalog
# and visits ONLY chapters not found in the existing verified GitHub archive.
# If all previously discovered episodes are already verified and archived,
# do not reopen or redownload the source. This is especially important when
# resuming a Cloudflare-only failure after dozens of completed chapters.
$archiveState = (& .\.venv\Scripts\python.exe comic_archiver.py --archive-needed | Select-Object -Last 1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect local archive completion state.' }
$skipArchive = ($archiveState -eq 'READY')
if ($skipArchive) {
  Write-Host 'Existing GitHub manifests verified. No source traversal, lazy scrolling, downloads, or repeat uploads needed. Checking Cloudflare publication.' -ForegroundColor Green
} else {
  & .\.venv\Scripts\python.exe comic_archiver.py --archive --authorized @sourceArgs
  if ($LASTEXITCODE -ne 0) { throw 'Archiving paused; see .archiver_state\events.jsonl. Rerun setup or use --resume.' }
}
$deployArgs = @('--deploy','--authorized')
if ($ShutdownWhenDone) { $deployArgs += '--shutdown-on-complete' }
Write-Host 'Cloudflare publication is starting. Live volume reconstruction, upload, and verification progress will appear below.' -ForegroundColor Cyan
& .\.venv\Scripts\python.exe comic_archiver.py @deployArgs
if ($LASTEXITCODE -ne 0) { throw 'Cloudflare deployment paused; verified GitHub images remain archived. No shutdown was requested.' }
Write-Host 'Comic archiver finished successfully; no more tasks are running.' -ForegroundColor Green
