# ApexWeb OS installer for Windows 10/11.
#
# Installs (via winget, if missing): Git, Node.js LTS, Docker Desktop, Obsidian.
# Then: sets up the ApexWeb folder and a private .env (random secrets, your
# NVIDIA keys), creates/links your Obsidian vault, starts the services and the
# desktop app, and makes everything start automatically when you log in.
#
# Run in PowerShell:
#   powershell -ExecutionPolicy Bypass -File desktop\install\install-windows.ps1
# Re-running is safe: existing settings and keys are kept.
param(
  [string]$InstallDir = "$env:USERPROFILE\ApexWeb",
  [string]$RepoUrl = "https://github.com/c07822343-cmyk/Test.git",
  [string]$Branch = "claude/vigilant-allen-k8zyr9",
  [string]$VaultPath = ""
)
$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }
function Install-App($id, $cmd, $name) {
  if ($cmd -and (Have $cmd)) { Write-Host "$name already installed."; return }
  if (-not (Have "winget")) { throw "winget is not available. Install 'App Installer' from the Microsoft Store, then re-run." }
  Write-Host "Installing $name..."
  winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  Refresh-Path
}
function New-Secret { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString("x2") }) -join "" }
function Set-EnvValue($file, $key, $value) {
  $lines = if (Test-Path $file) { @(Get-Content $file) } else { @() }
  $found = $false
  $lines = @($lines | ForEach-Object { if ($_ -match "^\s*$key\s*=") { $found = $true; "$key=$value" } else { $_ } })
  if (-not $found) { $lines += "$key=$value" }
  # UTF-8 without BOM (docker compose and Obsidian do not expect a BOM).
  [IO.File]::WriteAllLines($file, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
}
function Get-EnvValue($file, $key) {
  if (-not (Test-Path $file)) { return "" }
  $m = Select-String -Path $file -Pattern "^\s*$key\s*=(.*)$" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value.Trim() } else { return "" }
}

Step "Installing prerequisites"
Install-App "Git.Git" "git" "Git"
Install-App "OpenJS.NodeJS.LTS" "node" "Node.js"
Install-App "Docker.DockerDesktop" "docker" "Docker Desktop"
$obsidianExe = "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe"
if (Test-Path $obsidianExe) { Write-Host "Obsidian already installed." } else { Install-App "Obsidian.Obsidian" $null "Obsidian" }

Step "Getting ApexWeb OS"
$here = Resolve-Path (Join-Path $PSScriptRoot "..\..") -ErrorAction SilentlyContinue
if ($here -and (Test-Path (Join-Path $here "docker-compose.yml"))) { $InstallDir = $here.Path; Write-Host "Using this folder: $InstallDir" }
elseif (Test-Path (Join-Path $InstallDir "docker-compose.yml")) { git -C $InstallDir pull --ff-only | Out-Host }
else { git clone --branch $Branch $RepoUrl $InstallDir | Out-Host }
Set-Location $InstallDir

Step "Configuring (.env)"
$envFile = Join-Path $InstallDir ".env"
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $InstallDir ".env.example") $envFile }
foreach ($k in "APEXWEB_API_TOKEN", "POSTGRES_PASSWORD", "N8N_WEBHOOK_SECRET", "N8N_ENCRYPTION_KEY") {
  if (-not (Get-EnvValue $envFile $k)) { Set-EnvValue $envFile $k (New-Secret) }
}
for ($i = 1; $i -le 4; $i++) {
  if (-not (Get-EnvValue $envFile "NVIDIA_API_KEY_$i")) {
    $s = Read-Host "NVIDIA API key $i (starts with nvapi-; press Enter to skip)" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    if ($plain) { Set-EnvValue $envFile "NVIDIA_API_KEY_$i" $plain.Trim() }
  }
}
if (-not $VaultPath) { $VaultPath = Get-EnvValue $envFile "OBSIDIAN_VAULT_HOST_PATH" }
if (-not $VaultPath) {
  $default = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "ApexWeb Vault"
  $answer = Read-Host "Obsidian vault folder (Enter for '$default', or paste the path of an existing vault)"
  $VaultPath = if ($answer) { $answer.Trim('"') } else { $default }
}
New-Item -ItemType Directory -Force -Path $VaultPath | Out-Null
Set-EnvValue $envFile "OBSIDIAN_VAULT_HOST_PATH" ($VaultPath -replace "\\", "/")
# Only your Windows account can read the .env file (it holds your keys).
icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

Step "Starting Docker Desktop"
$dockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (Test-Path $dockerDesktop) { Start-Process $dockerDesktop -ErrorAction SilentlyContinue }
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) { docker info *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 3 }
if ($LASTEXITCODE -ne 0) { throw "Docker did not start. Open Docker Desktop once (accept its terms), then re-run this installer." }

Step "Starting ApexWeb services (first run builds the image; this can take a few minutes)"
docker compose up -d --build | Out-Host

Step "Installing the desktop app"
Push-Location (Join-Path $InstallDir "desktop")
npm install --no-audit --no-fund | Out-Host
Pop-Location
$electron = Join-Path $InstallDir "desktop\node_modules\electron\dist\electron.exe"
$appDir = Join-Path $InstallDir "desktop"
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Desktop"), (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "ApexWeb OS.lnk"))
  $lnk.TargetPath = $electron
  $lnk.Arguments = "`"$appDir`""
  $lnk.WorkingDirectory = $appDir
  $lnk.IconLocation = $electron
  $lnk.Description = "ApexWeb OS"
  $lnk.Save()
}

Step "Registering the vault with Obsidian"
$obsCfgDir = Join-Path $env:APPDATA "obsidian"
$obsCfg = Join-Path $obsCfgDir "obsidian.json"
New-Item -ItemType Directory -Force -Path $obsCfgDir | Out-Null
$cfg = if (Test-Path $obsCfg) { Get-Content $obsCfg -Raw | ConvertFrom-Json } else { [pscustomobject]@{ vaults = [pscustomobject]@{} } }
if (-not $cfg.vaults) { $cfg | Add-Member -NotePropertyName vaults -NotePropertyValue ([pscustomobject]@{}) -Force }
$full = (Resolve-Path $VaultPath).Path
$known = $cfg.vaults.PSObject.Properties | Where-Object { $_.Value.path -eq $full }
if (-not $known) {
  if (Get-Process Obsidian -ErrorAction SilentlyContinue) { Write-Host "Obsidian is open; use 'Open folder as vault' and pick $full once." }
  else {
    $id = -join ((1..16) | ForEach-Object { "{0:x}" -f (Get-Random -Maximum 16) })
    $cfg.vaults | Add-Member -NotePropertyName $id -NotePropertyValue ([pscustomobject]@{ path = $full; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); open = $true })
    [IO.File]::WriteAllText($obsCfg, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  }
}

Step "Launching"
$env:APEXWEB_HOME = $InstallDir
Start-Process $electron -ArgumentList "`"$appDir`""
Start-Process "obsidian://open?path=$([uri]::EscapeDataString($VaultPath))"

Write-Host "`nDone." -ForegroundColor Green
Write-Host "  ApexWeb OS is in your tray (bottom-right) and starts when you log in."
Write-Host "  Dashboard: http://localhost:8080    n8n: http://localhost:5678"
Write-Host "  Obsidian vault: $VaultPath  (ApexWeb notes appear in the ApexWeb folder within a minute)"
Write-Host "  Check your NVIDIA keys any time from the app: NVIDIA keys & usage -> Check keys."
