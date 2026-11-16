#Requires -Version 5.1
<#
.SYNOPSIS
  figma-mcp-server 安装脚本（版本化安装目录 + Junction 原子切换）。

.DESCRIPTION
  安装目录布局：
    <InstallDir>\versions\<x.y.z>\{index.mjs, broker.mjs, plugin\, VERSION}
    <InstallDir>\current  → Junction → versions\<x.y.z>
    <InstallDir>\.env     （跨版本保留）
  .claude.json 固定注册 current\index.mjs，升级/回滚无需重新注册。

  动作：
    install   全新安装
    upgrade   安装新版本并切换（默认检查 latest，已有则询问）
    rollback  切回已存在的旧版本（-Version 必填）
    uninstall 卸载（删除安装目录 + 注销 .claude.json 项）
    auto（默认）无 current → install；有 current → upgrade 检查

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Action rollback -Version 1.0.7
#>
param(
  [string]$InstallDir = $(if ($PSScriptRoot) { Join-Path $PSScriptRoot 'release' } else { Join-Path $env:USERPROFILE 'figma-mcp-server' }),
  [ValidateSet('auto','install','upgrade','rollback','uninstall')]
  [string]$Action = 'auto',
  [string]$Version = 'latest',
  [switch]$Prerelease,
  [string]$ClaudeConfigPath = (Join-Path $env:USERPROFILE '.claude.json')
)

$ErrorActionPreference = 'Stop'
$ServerName = 'figma-mcp-server'
$KeepVersions = 3

function Write-JsonNoBom($path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-InstalledVersion {
  $verFile = Join-Path $InstallDir 'current\VERSION'
  if (Test-Path $verFile) { return (Get-Content $verFile -Raw).Trim() }
  return $null
}

function Stop-Broker {
  # PS 5.1 下 $ErrorActionPreference='Stop' 会把原生命令的 stderr 行当错误终止脚本（taskkill "找不到进程"），
  # 此处临时放宽——kill 本来就是尽力而为
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $pidFile = Join-Path $env:LOCALAPPDATA 'figma-mcp-server\broker.pid'
    if (Test-Path $pidFile) {
      $brokerPid = (Get-Content $pidFile -Raw).Trim()
      if ($brokerPid -match '^\d+$') {
        taskkill /PID $brokerPid /F 2>&1 | Out-Null
      }
    }
    # 兜底：按端口 3056 清 listener，防 pid 文件失真
    netstat -ano | Select-String ':3056.*LISTENING' | ForEach-Object {
      $p = ($_ -split '\s+')[-1]
      if ($p -match '^\d+$') { taskkill /PID $p /F 2>&1 | Out-Null }
    }
    # 清孤儿 --fe-child 子进程
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -like '*--fe-child=*'
    } | ForEach-Object { taskkill /PID $_.ProcessId /F 2>&1 | Out-Null }
  } finally {
    $ErrorActionPreference = $prevEAP
  }
}

function Switch-Current($versionDir) {
  $link = Join-Path $InstallDir 'current'
  if (Test-Path $link) { Remove-Item $link -Recurse -Force }
  $null = New-Item -ItemType Junction -Path $link -Target $versionDir
}

# --- 0. 前置 ------------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found on PATH. Install Node.js 20+ first: https://nodejs.org'
}
$repoMode = [bool]$PSScriptRoot
$repoVersion = $null
$repoPkgPath = Join-Path $PSScriptRoot 'package.json'
if ($repoMode -and (Test-Path $repoPkgPath)) {
  $repoVersion = (Get-Content $repoPkgPath -Raw | ConvertFrom-Json).version
}

# --- uninstall 早退 -----------------------------------------------------------
if ($Action -eq 'uninstall') {
  Stop-Broker
  if (Test-Path $ClaudeConfigPath) {
    $cfg = Get-Content $ClaudeConfigPath -Raw | ConvertFrom-Json
    if ($cfg.mcpServers -and $cfg.mcpServers.$ServerName) {
      $cfg.mcpServers.PSObject.Properties.Remove($ServerName)
      Write-JsonNoBom $ClaudeConfigPath $cfg
      Write-Host "[ok] 已从 $ClaudeConfigPath 注销 $ServerName" -ForegroundColor Green
    }
  }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Host "[ok] 已删除 $InstallDir。state 目录保留：$env:LOCALAPPDATA\figma-mcp-server（含频道码，重装免配对）" -ForegroundColor Green
  return
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$installedVersion = Get-InstalledVersion

# --- 解析目标版本 --------------------------------------------------------------
# 显式 -Version 优先（rollback 必需）；否则仓库模式取 package.json；否则取 GitHub latest
$targetVersion = $null
if ($Version -ne 'latest') {
  $targetVersion = $Version -replace '^v',''
} elseif ($repoMode -and $repoVersion) {
  $targetVersion = $repoVersion
  Write-Host "[..] 仓库模式：版本 = $targetVersion（package.json）"
} else {
  try {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/HW-public/figma-mcp-server/releases/latest' -TimeoutSec 8
    if ($Prerelease) { throw 'prerelease 需显式 -Version' }
    $targetVersion = $rel.tag_name -replace '^v',''
  } catch {
    throw "获取 latest release 失败（离线？）：$($_.Exception.Message)`n可显式 -Version x.y.z 指定。"
  }
}

# --- auto 动作分派 -------------------------------------------------------------
if ($Action -eq 'auto') {
  if (-not $installedVersion) { $Action = 'install' }
  elseif ($installedVersion -ne $targetVersion) {
    Write-Host "已装 v$installedVersion → 目标 v$targetVersion"
    $answer = Read-Host "执行 upgrade? [Y/n]"
    if ($answer -eq '' -or $answer -match '^[Yy]') { $Action = 'upgrade' }
    else { Write-Host '已取消。'; return }
  }
  else { Write-Host "[ok] 已是最新版本 v$installedVersion"; return }
}
if ($Action -eq 'upgrade' -and $installedVersion -eq $targetVersion) {
  Write-Host "[ok] 已是最新版本 v$targetVersion"; return
}

# --- rollback 校验 -------------------------------------------------------------
$versionsDir = Join-Path $InstallDir 'versions'
if ($Action -eq 'rollback') {
  $rollbackDir = Join-Path $versionsDir $targetVersion
  if (-not (Test-Path $rollbackDir)) { throw "versions\$targetVersion 不存在，无法回滚。现有版本：$((Get-ChildItem $versionsDir -Directory -ErrorAction SilentlyContinue).Name -join ', ')" }
  Stop-Broker
  Switch-Current $rollbackDir
  Write-Host "[ok] 已回滚到 v$targetVersion（Junction 已切换，broker 下次调用自动拉起新版本）" -ForegroundColor Green
  return
}

# --- install / upgrade：准备 versions\<v> 目录 ---------------------------------
$versionDir = Join-Path $versionsDir $targetVersion
if (-not (Test-Path $versionDir)) {
  New-Item -ItemType Directory -Force -Path $versionDir, (Join-Path $versionDir 'plugin') | Out-Null

  if ($repoMode -and (Test-Path (Join-Path $PSScriptRoot 'dist\bundle\index.mjs'))) {
    Copy-Item (Join-Path $PSScriptRoot 'dist\bundle\index.mjs') (Join-Path $versionDir 'index.mjs') -Force
    Copy-Item (Join-Path $PSScriptRoot 'dist\bundle\broker.mjs') (Join-Path $versionDir 'broker.mjs') -Force
    Copy-Item (Join-Path $PSScriptRoot 'plugin\code.js') (Join-Path $versionDir 'plugin\code.js') -Force
    Copy-Item (Join-Path $PSScriptRoot 'plugin\manifest.json') (Join-Path $versionDir 'plugin\manifest.json') -Force
    Write-Host "[ok] 仓库产物已拷贝 -> $versionDir" -ForegroundColor Green
  } else {
    $base = "https://github.com/HW-public/figma-mcp-server/releases/download/v$targetVersion"
    Write-Host "[..] 下载 v$targetVersion 产物 ..."
    Invoke-WebRequest "$base/index.mjs" -OutFile (Join-Path $versionDir 'index.mjs') -UseBasicParsing
    Invoke-WebRequest "$base/broker.mjs" -OutFile (Join-Path $versionDir 'broker.mjs') -UseBasicParsing
    Invoke-WebRequest "$base/code.js" -OutFile (Join-Path $versionDir 'plugin\code.js') -UseBasicParsing
    Invoke-WebRequest "$base/manifest.json" -OutFile (Join-Path $versionDir 'plugin\manifest.json') -UseBasicParsing
    Write-Host "[ok] 产物已下载 -> $versionDir" -ForegroundColor Green
  }
  Set-Content (Join-Path $versionDir 'VERSION') $targetVersion -NoNewline
} else {
  Write-Host "[ok] versions\$targetVersion 已存在，仅切换" -ForegroundColor Green
}

# --- 旧平铺布局迁移（一次性） ----------------------------------------------------
if ((Test-Path (Join-Path $InstallDir 'index.mjs')) -and -not (Test-Path (Join-Path $InstallDir 'current'))) {
  $legacyDir = Join-Path $versionsDir 'legacy'
  New-Item -ItemType Directory -Force -Path $legacyDir | Out-Null
  Move-Item (Join-Path $InstallDir 'index.mjs') $legacyDir -Force
  Move-Item (Join-Path $InstallDir 'broker.mjs') $legacyDir -Force -ErrorAction SilentlyContinue
  if (Test-Path (Join-Path $InstallDir 'plugin')) { Move-Item (Join-Path $InstallDir 'plugin') (Join-Path $legacyDir 'plugin') -Force }
  Write-Host "[ok] 旧平铺布局已迁移到 versions\legacy" -ForegroundColor Yellow
}

# --- 停旧 broker + 原子切换 ------------------------------------------------------
Stop-Broker
Switch-Current $versionDir
Write-Host "[ok] current → versions\$targetVersion" -ForegroundColor Green

# --- .env（跨版本保留，不覆盖） ---------------------------------------------------
$envFile = Join-Path $InstallDir '.env'
if (-not (Test-Path $envFile)) {
  $template = Join-Path $PSScriptRoot '.env.example'
  if ($repoMode -and (Test-Path $template)) {
    Copy-Item $template $envFile
  } else {
    New-Item -ItemType File -Path $envFile | Out-Null
  }
  Write-Host "[ok] 已创建 $envFile -- 需要 REST 通道时填入 FIGMA_API_KEY" -ForegroundColor Yellow
}

# --- 注册 .claude.json（路径固定 current\index.mjs，升级无需重注册） --------------
if (Test-Path $ClaudeConfigPath) { Copy-Item $ClaudeConfigPath "$ClaudeConfigPath.bak" -Force }
$entryJson = (@{
  command = 'node'
  args    = @((Join-Path $InstallDir 'current\index.mjs'))
} | ConvertTo-Json -Depth 5 -Compress)
$mergeJs = @'
const fs = require('fs');
const [cfgPath, name] = process.argv.slice(1);
const entry = JSON.parse(process.env.FIGMA_MCP_ENTRY_JSON);
let cfg = {};
try {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  if (raw.trim()) cfg = JSON.parse(raw);
} catch (e) {
  console.error('读取 ' + cfgPath + ' 失败: ' + e.message);
  process.exit(1);
}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers[name] = entry;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
'@
$env:FIGMA_MCP_ENTRY_JSON = $entryJson
& node -e $mergeJs $ClaudeConfigPath $ServerName
$mergeExit = $LASTEXITCODE
Remove-Item Env:\FIGMA_MCP_ENTRY_JSON
if ($mergeExit -ne 0) { throw "注册写入 $ClaudeConfigPath 失败" }
Write-Host "[ok] 已注册 $ServerName -> $ClaudeConfigPath (current\index.mjs)" -ForegroundColor Green

# --- 清理旧版本（保留最近 $KeepVersions 个） --------------------------------------
$allVersions = Get-ChildItem $versionsDir -Directory | Sort-Object -Descending {
  $v = $null
  if ([version]::TryParse(($_.Name -replace '-.+$',''), [ref]$v)) { $v } else { [version]'0.0.0' }
}
if ($allVersions.Count -gt $KeepVersions) {
  $currentTarget = (Get-Item (Join-Path $InstallDir 'current')).Target[0]
  $allVersions | Select-Object -Skip $KeepVersions | Where-Object { $_.FullName -ne $currentTarget } | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force
    Write-Host "[ok] 已清理旧版本 $($_.Name)" -ForegroundColor Yellow
  }
}

# --- 提示 ------------------------------------------------------------------------
Write-Host ""
Write-Host "Done. v$targetVersion 就绪（重启 Claude Code 生效）。" -ForegroundColor Green
Write-Host ""
Write-Host "Figma 插件（首次 30 秒）：" -ForegroundColor Yellow
Write-Host "  1. Figma desktop -> Plugins -> Development -> Import plugin from manifest..." -ForegroundColor Yellow
Write-Host "  2. 选择: $(Join-Path $InstallDir 'current\plugin\manifest.json')" -ForegroundColor Yellow
Write-Host "  3. 日常：打开插件点 Connect 即可（频道码持久化，Claude 自动加入）" -ForegroundColor Yellow
Write-Host ""
Write-Host "升级：重跑本脚本 ｜ 回滚：-Action rollback -Version <旧版本>" -ForegroundColor Yellow
