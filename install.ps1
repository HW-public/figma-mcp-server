#Requires -Version 5.1
<#
.SYNOPSIS
  figma-mcp-server one-click installer (single-file bundle).

.DESCRIPTION
  Installs the prebuilt single-file bundle: copies (or downloads) index.mjs,
  installs the runtime dependency (figma-edit-mcp, spawned as child process),
  creates a .env, registers the server in .mcp.json and enables it in
  settings.local.json. Idempotent — safe to re-run. Original config files
  are backed up to *.bak before modification.

  Two modes:
    1. Run from a cloned repo — uses the local dist/bundle/index.mjs.
    2. Run standalone (e.g. via iex from GitHub) — downloads the latest
       Release bundle from GitHub.

.EXAMPLE
  # Standalone install (no repo clone, no build):
  powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/HW-public/figma-mcp-server/main/install.ps1'))"

.EXAMPLE
  # From a cloned repo:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#>
param(
  [string]$InstallDir = $(if ($PSScriptRoot) { Join-Path $PSScriptRoot 'release' } else { Join-Path $env:USERPROFILE 'figma-mcp-server' }),
  [string]$DownloadUrl = 'https://github.com/HW-public/figma-mcp-server/releases/latest/download/index.mjs',
  [string]$EnvTemplateUrl = 'https://cdn.jsdelivr.net/gh/HW-public/figma-mcp-server@main/.env.example',
  [string]$PluginCodeUrl = 'https://github.com/HW-public/figma-mcp-server/releases/latest/download/code.js',
  [string]$PluginManifestUrl = 'https://github.com/HW-public/figma-mcp-server/releases/latest/download/manifest.json',
  [string]$McpConfigPath = (Join-Path $env:USERPROFILE '.mcp.json'),
  [string]$SettingsPath = (Join-Path $env:USERPROFILE '.claude\settings.local.json')
)

$ErrorActionPreference = 'Stop'
$ServerName = 'figma-mcp-server'
$FigmaEditVersion = '2.3.3'

function Write-JsonNoBom($path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-JsonOrDefault($path, $defaultObj) {
  if (Test-Path $path) {
    $raw = Get-Content $path -Raw
    if ($raw -and $raw.Trim()) { return ($raw | ConvertFrom-Json) }
  }
  return $defaultObj
}

# --- 0. Preconditions ---------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found on PATH. Install Node.js 20+ first: https://nodejs.org'
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir 'index.mjs'

# --- 1. Obtain the single-file bundle ------------------------------------------
$localBundle = $(if ($PSScriptRoot) { Join-Path $PSScriptRoot 'dist\bundle\index.mjs' } else { $null })
if ($localBundle -and (Test-Path $localBundle)) {
  Copy-Item $localBundle $target -Force
  Write-Host "[ok] Copied index.mjs -> $InstallDir" -ForegroundColor Green
} else {
  Write-Host "[..] Downloading bundle from $DownloadUrl"
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $target -UseBasicParsing
  Write-Host "[ok] Downloaded index.mjs -> $InstallDir" -ForegroundColor Green
}

# --- 1.5 Runtime dependency (figma-edit-mcp, spawned as child process) --------
# The bundle resolves figma-edit-mcp from <InstallDir>\node_modules, so the
# install dir needs its own minimal node_modules even in repo mode.
$runtimePkg = Join-Path $InstallDir 'package.json'
$needsInstall = $true
if (Test-Path $runtimePkg) {
  try {
    $pkg = Get-Content $runtimePkg -Raw | ConvertFrom-Json
    if ($pkg.dependencies -and $pkg.dependencies.'figma-edit-mcp' -eq $FigmaEditVersion) { $needsInstall = $false }
  } catch { $needsInstall = $true }
}
if ($needsInstall) {
  Write-JsonNoBom $runtimePkg ([pscustomobject]@{
    name = 'figma-mcp-runtime'
    private = $true
    version = '0.0.0'
    dependencies = [pscustomobject]@{ 'figma-edit-mcp' = $FigmaEditVersion }
  })
  Write-Host "[..] Installing runtime dependency figma-edit-mcp@$FigmaEditVersion ..."
  Push-Location $InstallDir
  try {
    npm install --omit=dev --no-audit --no-fund 2>&1 | Out-Null
    Write-Host "[ok] Runtime dependency installed" -ForegroundColor Green
  } finally {
    Pop-Location
  }
} else {
  Write-Host "[ok] Runtime dependency already present" -ForegroundColor Green
}

# --- 1.6 Figma plugin (self-contained single file + manifest) ------------------
$pluginDir = Join-Path $InstallDir 'plugin'
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
$localPluginCode = $(if ($PSScriptRoot) { Join-Path $PSScriptRoot 'plugin\code.js' } else { $null })
$localPluginManifest = $(if ($PSScriptRoot) { Join-Path $PSScriptRoot 'plugin\manifest.json' } else { $null })
if ($localPluginCode -and (Test-Path $localPluginCode) -and $localPluginManifest -and (Test-Path $localPluginManifest)) {
  Copy-Item $localPluginCode (Join-Path $pluginDir 'code.js') -Force
  Copy-Item $localPluginManifest (Join-Path $pluginDir 'manifest.json') -Force
  Write-Host "[ok] Copied plugin -> $pluginDir" -ForegroundColor Green
} else {
  Write-Host "[..] Downloading plugin from GitHub Release"
  Invoke-WebRequest -Uri $PluginCodeUrl -OutFile (Join-Path $pluginDir 'code.js') -UseBasicParsing
  Invoke-WebRequest -Uri $PluginManifestUrl -OutFile (Join-Path $pluginDir 'manifest.json') -UseBasicParsing
  Write-Host "[ok] Downloaded plugin -> $pluginDir" -ForegroundColor Green
}

# --- 2. .env ------------------------------------------------------------------
$envFile = Join-Path $InstallDir '.env'
if (-not (Test-Path $envFile)) {
  $realEnv = $(if ($PSScriptRoot) { Join-Path $PSScriptRoot '.env' } else { $null })
  $created = $false
  if ($realEnv -and (Test-Path $realEnv)) {
    Copy-Item $realEnv $envFile
    Write-Host "[ok] Copied project .env -> $envFile" -ForegroundColor Green
    $created = $true
  } else {
    try {
      Invoke-WebRequest -Uri $EnvTemplateUrl -OutFile $envFile -UseBasicParsing
      Write-Host "[ok] Created $envFile from template" -ForegroundColor Yellow
      $created = $true
    } catch {
      New-Item -ItemType File -Path $envFile | Out-Null
    }
  }
  if ($created) {
    Write-Host "     --> fill in FIGMA_API_KEY if you need the REST channel" -ForegroundColor Yellow
  } else {
    Write-Host "[ok] Created empty $envFile -- fill in FIGMA_API_KEY if needed" -ForegroundColor Yellow
  }
} else {
  Write-Host "[ok] .env already exists, kept as-is" -ForegroundColor Green
}

# --- 3. Register in .mcp.json --------------------------------------------------
$mcp = Read-JsonOrDefault $McpConfigPath ([pscustomobject]@{ mcpServers = [pscustomobject]@{} })
if (-not $mcp.mcpServers) {
  $mcp | Add-Member -Force -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
}

$entry = [pscustomobject]@{
  command = 'node'
  args    = @($target)
}

if (Test-Path $McpConfigPath) {
  Copy-Item $McpConfigPath "$McpConfigPath.bak" -Force
}

$servers = $mcp.mcpServers
$existing = $servers.PSObject.Properties[$ServerName]
if ($existing) {
  $existing.Value = $entry
} else {
  $servers | Add-Member -NotePropertyName $ServerName -NotePropertyValue $entry
}

Write-JsonNoBom $McpConfigPath $mcp
Write-Host "[ok] Registered $ServerName in $McpConfigPath (backup: $McpConfigPath.bak)" -ForegroundColor Green

# --- 4. Enable in settings.local.json -------------------------------------------
$settings = Read-JsonOrDefault $SettingsPath ([pscustomobject]@{})
$enabled = @()
if ($settings.enabledMcpjsonServers) {
  $enabled = @($settings.enabledMcpjsonServers)
}

if ($enabled -notcontains $ServerName) {
  if (Test-Path $SettingsPath) {
    Copy-Item $SettingsPath "$SettingsPath.bak" -Force
  }
  $enabled += $ServerName
  $settings | Add-Member -Force -NotePropertyName enabledMcpjsonServers -NotePropertyValue $enabled
  Write-JsonNoBom $SettingsPath $settings
  Write-Host "[ok] Enabled $ServerName in $SettingsPath (backup: $SettingsPath.bak)" -ForegroundColor Green
} else {
  Write-Host "[ok] $ServerName already enabled in settings.local.json" -ForegroundColor Green
}

# --- 5. Reminders ----------------------------------------------------------------
Write-Host ""
Write-Host "Done. Restart Claude Code to load $ServerName." -ForegroundColor Green
Write-Host ""
Write-Host "One-time Figma setup (30 seconds):" -ForegroundColor Yellow
Write-Host "  1. Figma desktop -> Plugins -> Development -> Import plugin from manifest..." -ForegroundColor Yellow
Write-Host "  2. Select: $pluginDir\manifest.json" -ForegroundColor Yellow
Write-Host "  3. Later use: Plugins -> Development -> Figma Edit MCP -> Connect" -ForegroundColor Yellow
Write-Host "     (channel code is now stable & auto-saved; Claude joins automatically)" -ForegroundColor Yellow
Write-Host ""
Write-Host "Optional cleanup once figma-mcp-server works: remove old registrations:" -ForegroundColor Yellow
Write-Host "  claude mcp remove FigmaEdit" -ForegroundColor Yellow
Write-Host "  claude mcp remove figma-dev   (already removed if absent)" -ForegroundColor Yellow
