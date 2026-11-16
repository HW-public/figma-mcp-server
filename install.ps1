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
  [string]$ClaudeConfigPath = (Join-Path $env:USERPROFILE '.claude.json'),
  [string]$ProfileDir = $env:USERPROFILE,
  [string[]]$Clients = @()   # 空 = 自动探测全部；否则只注册指定显示名（如 'Claude Code','Cursor'）
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
# iex 模式下 $PSScriptRoot 为空串，Join-Path 必须只在仓库模式执行（空 Path 会直接报错）
if ($repoMode) {
  $repoPkgPath = Join-Path $PSScriptRoot 'package.json'
  if (Test-Path $repoPkgPath) {
    $repoVersion = (Get-Content $repoPkgPath -Raw | ConvertFrom-Json).version
  }
}

# --- 客户端注册表 --------------------------------------------------------------
# 自动探测各 AI 客户端的 MCP 配置文件，存在的才注册；$Clients 非空时只注册指定项。
# JSON 客户端共用 Node 合并器（规避 PS 对仅大小写不同重复键的解析缺陷），TOML（Codex）单独处理。
$script:McpEntryJson = $null
$script:McpEntryPath = $null

$mergeJs = @'
const fs = require('fs');
const [cfgPath, name, serversKey] = process.argv.slice(1);
const entry = JSON.parse(process.env.FIGMA_MCP_ENTRY_JSON || 'null');
let cfg = {};
try {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  if (raw.trim()) cfg = JSON.parse(raw);
} catch (e) {
  console.error('读取 ' + cfgPath + ' 失败: ' + e.message);
  process.exit(1);
}
cfg[serversKey] = cfg[serversKey] || {};
if (process.env.FIGMA_MCP_REMOVE === '1') {
  delete cfg[serversKey][name];
} else {
  cfg[serversKey][name] = entry;
}
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
'@

function Register-JsonClient([string]$displayName, [string]$cfgPath, [string]$serversKey, [bool]$remove) {
  if (-not (Test-Path $cfgPath)) {
    if (-not $remove) { Write-Host "[..] 未检测到 $displayName（$cfgPath），跳过" -ForegroundColor DarkGray }
    return $false
  }
  try {
    Copy-Item $cfgPath "$cfgPath.bak" -Force
    $env:FIGMA_MCP_ENTRY_JSON = $script:McpEntryJson
    if ($remove) { $env:FIGMA_MCP_REMOVE = '1' } else { Remove-Item Env:\FIGMA_MCP_REMOVE -ErrorAction SilentlyContinue }
    & node -e $mergeJs $cfgPath $ServerName $serversKey
    $code = $LASTEXITCODE
    Remove-Item Env:\FIGMA_MCP_ENTRY_JSON
    Remove-Item Env:\FIGMA_MCP_REMOVE -ErrorAction SilentlyContinue
    if ($code -ne 0) {
      Write-Host "[!!] $displayName 写入失败（原配置已 .bak 备份）: $cfgPath" -ForegroundColor Red
      return $false
    }
    if ($remove) { Write-Host "[ok] 已从 $displayName 注销" -ForegroundColor Green }
    else { Write-Host "[ok] 已注册 $displayName -> $cfgPath" -ForegroundColor Green }
    return $true
  } catch {
    Write-Host "[!!] $displayName 异常: $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}

# Codex CLI 用 TOML：节级 upsert [mcp_servers.<name>]（args 用正斜杠路径避免转义）
function Register-TomlClient([string]$displayName, [string]$cfgPath, [bool]$remove) {
  if (-not (Test-Path $cfgPath)) {
    if (-not $remove) { Write-Host "[..] 未检测到 $displayName（$cfgPath），跳过" -ForegroundColor DarkGray }
    return $false
  }
  try {
    Copy-Item $cfgPath "$cfgPath.bak" -Force
    $sectionHeader = "[mcp_servers.$ServerName]"
    $tomlEntry = @"
$sectionHeader
command = "node"
args = ["$($script:McpEntryPath -replace '\\','/')"]
"@
    $out = New-Object System.Collections.Generic.List[string]
    $inOur = $false; $wrote = $false
    foreach ($ln in (Get-Content $cfgPath)) {
      if ($ln -match '^\[') {
        if ($inOur) { continue }                    # 旧节整段丢弃
        $inOur = ($ln -eq $sectionHeader)
        if ($inOur) { continue }
      }
      $out.Add($ln)
    }
    if (-not $remove) { $out.AddRange([string[]](($tomlEntry -replace "`r", '') -split "`n")) }
    [System.IO.File]::WriteAllLines($cfgPath, $out, (New-Object System.Text.UTF8Encoding($false)))
    if ($remove) { Write-Host "[ok] 已从 $displayName 注销" -ForegroundColor Green }
    else { Write-Host "[ok] 已注册 $displayName -> $cfgPath" -ForegroundColor Green }
    return $true
  } catch {
    Write-Host "[!!] $displayName 异常: $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}

# OpenCode 用独立 JSON 结构：{ "mcp": { "<name>": { "type": "local", "command": ["node", "<path>"] } } }
$mergeJsOpencode = @'
const fs = require('fs');
const [cfgPath, name] = process.argv.slice(1);
let cfg = {};
try {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  if (raw.trim()) cfg = JSON.parse(raw);
} catch (e) {
  console.error('读取 ' + cfgPath + ' 失败: ' + e.message);
  process.exit(1);
}
cfg.mcp = cfg.mcp || {};
if (process.env.FIGMA_MCP_REMOVE === '1') {
  delete cfg.mcp[name];
} else {
  cfg.mcp[name] = { type: 'local', command: ['node', process.env.FIGMA_MCP_OPENCODE_PATH] };
}
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
'@

function Register-OpencodeClient([string]$displayName, [string]$cfgPath, [bool]$remove) {
  if (-not (Test-Path $cfgPath)) {
    if (-not $remove) { Write-Host "[..] 未检测到 $displayName（$cfgPath），跳过" -ForegroundColor DarkGray }
    return $false
  }
  try {
    Copy-Item $cfgPath "$cfgPath.bak" -Force
    $env:FIGMA_MCP_OPENCODE_PATH = $script:McpEntryPath
    if ($remove) { $env:FIGMA_MCP_REMOVE = '1' } else { Remove-Item Env:\FIGMA_MCP_REMOVE -ErrorAction SilentlyContinue }
    & node -e $mergeJsOpencode $cfgPath $ServerName
    $code = $LASTEXITCODE
    Remove-Item Env:\FIGMA_MCP_OPENCODE_PATH
    Remove-Item Env:\FIGMA_MCP_REMOVE -ErrorAction SilentlyContinue
    if ($code -ne 0) {
      Write-Host "[!!] $displayName 写入失败（原配置已 .bak 备份）: $cfgPath" -ForegroundColor Red
      return $false
    }
    if ($remove) { Write-Host "[ok] 已从 $displayName 注销" -ForegroundColor Green }
    else { Write-Host "[ok] 已注册 $displayName -> $cfgPath" -ForegroundColor Green }
    return $true
  } catch {
    Write-Host "[!!] $displayName 异常: $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}

# 注册表：新增客户端在此加一行即可。kind: json / toml / opencode
# 未收录（需配置样例确认 schema）：Hermes (~/.hermes/config.yaml, YAML)、DeepSeek Harness (~/.dsh/profiles/*/cordis.patch.yml, 多 profile YAML)
function Get-ClientRegistry {
  return @(
    @{ Name = 'Claude Code';    Path = $ClaudeConfigPath;                                        Key = 'mcpServers'; Kind = 'json'     },
    @{ Name = 'Cursor';         Path = (Join-Path $ProfileDir '.cursor\mcp.json');                 Key = 'mcpServers'; Kind = 'json'     },
    @{ Name = 'Windsurf';       Path = (Join-Path $ProfileDir '.codeium\windsurf\mcp_config.json'); Key = 'mcpServers'; Kind = 'json'    },
    @{ Name = 'Gemini CLI';     Path = (Join-Path $ProfileDir '.gemini\settings.json');            Key = 'mcpServers'; Kind = 'json'     },
    @{ Name = 'Codex CLI';      Path = (Join-Path $ProfileDir '.codex\config.toml');               Key = '';           Kind = 'toml'     },
    @{ Name = 'Grok Build';     Path = (Join-Path $ProfileDir '.grok\config.toml');                Key = '';           Kind = 'toml'     },
    @{ Name = 'OpenCode';       Path = (Join-Path $ProfileDir '.config\opencode\opencode.json');   Key = 'mcp';        Kind = 'opencode' },
    @{ Name = 'Pi';             Path = (Join-Path $ProfileDir '.pi\agent\mcp.json');               Key = 'mcpServers'; Kind = 'json'     },
    @{ Name = 'MiniMax Code';   Path = (Join-Path $ProfileDir '.minimax\mcp.json');               Key = 'mcpServers'; Kind = 'json'     },
    @{ Name = 'Kimi Code';      Path = (Join-Path $ProfileDir '.kimi-code\mcp.json');             Key = 'mcpServers'; Kind = 'json'     },
    @{ Name = 'Antigravity';    Path = (Join-Path $ProfileDir '.gemini\config\mcp_config.json');   Key = 'mcpServers'; Kind = 'json'     },
    @{ Name = 'Oh My Pi';       Path = (Join-Path $ProfileDir '.omp\agent\mcp.json');              Key = 'mcpServers'; Kind = 'json'     }
  )
}

function Register-AllClients([bool]$remove) {
  $registered = @()
  foreach ($c in Get-ClientRegistry) {
    if ($Clients.Count -gt 0 -and $Clients -notcontains $c.Name) { continue }
    $ok = $false
    if ($c.Kind -eq 'json') { $ok = Register-JsonClient $c.Name $c.Path $c.Key $remove }
    elseif ($c.Kind -eq 'toml') { $ok = Register-TomlClient $c.Name $c.Path $remove }
    else { $ok = Register-OpencodeClient $c.Name $c.Path $remove }
    if ($ok) { $registered += $c.Name }
  }
  return $registered
}

# --- uninstall 早退 -----------------------------------------------------------
if ($Action -eq 'uninstall') {
  Stop-Broker
  $script:McpEntryJson = '{}'
  $script:McpEntryPath = (Join-Path $InstallDir 'current\index.mjs')
  $unregistered = Register-AllClients $true
  if ($unregistered.Count -eq 0) { Write-Host "[..] 未在任何客户端配置中找到 $ServerName" -ForegroundColor DarkGray }
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
  else { Write-Host "[ok] 已装 v$installedVersion 即目标版本 → 继续校验并补注册（幂等）" -ForegroundColor Green }
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

# --- 停旧 broker + 原子切换（current 已指向目标时跳过，纯重注册/校验不打扰运行） ---
$curLink = Join-Path $InstallDir 'current'
$alreadyCurrent = (Test-Path $curLink) -and ((Get-Item $curLink -ErrorAction SilentlyContinue).Target[0] -eq $versionDir)
if ($alreadyCurrent) {
  Write-Host "[ok] current 已指向 versions\$targetVersion，无需切换" -ForegroundColor Green
} else {
  Stop-Broker
  Switch-Current $versionDir
  Write-Host "[ok] current → versions\$targetVersion" -ForegroundColor Green
}

# --- 注册前自检：current\index.mjs 必须真实可达（防 Junction 失效/资产缺失时注册坏路径） ---
$probeEntry = Join-Path $InstallDir 'current\index.mjs'
$probeBroker = Join-Path $InstallDir 'current\broker.mjs'
if (-not (Test-Path $probeEntry) -or -not (Test-Path $probeBroker)) {
  throw "注册自检失败：current 下缺少产物 ($probeEntry / $probeBroker)。Junction 或资产异常，已中止注册；安装目录保留待排查。"
}
Write-Host "[ok] 产物自检通过（index.mjs + broker.mjs 可达）" -ForegroundColor Green

# --- .env（跨版本保留，不覆盖） ---------------------------------------------------
$envFile = Join-Path $InstallDir '.env'
if (-not (Test-Path $envFile)) {
  # iex 模式下 $PSScriptRoot 为空串，Join-Path 只在仓库模式执行
  $template = $(if ($repoMode) { Join-Path $PSScriptRoot '.env.example' } else { '' })
  if ($template -and (Test-Path $template)) {
    Copy-Item $template $envFile
  } else {
    New-Item -ItemType File -Path $envFile | Out-Null
  }
  Write-Host "[ok] 已创建 $envFile -- 需要 REST 通道时填入 FIGMA_API_KEY" -ForegroundColor Yellow
}

# --- 客户端动态分发注册（探测到配置才注册；路径固定 current\index.mjs，升级无需重注册） ---
$script:McpEntryPath = Join-Path $InstallDir 'current\index.mjs'
$script:McpEntryJson = (@{ command = 'node'; args = @($script:McpEntryPath) } | ConvertTo-Json -Depth 5 -Compress)
$registeredClients = Register-AllClients $false
if ($registeredClients.Count -eq 0) {
  Write-Host "[!!] 警告：未检测到任何支持的 AI 客户端配置（Claude Code / Cursor / Windsurf / Gemini / Codex），已跳过注册。" -ForegroundColor Yellow
  Write-Host "     先启动过一次对应客户端让其生成配置，再重跑本脚本即可自动补上。" -ForegroundColor Yellow
}

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
