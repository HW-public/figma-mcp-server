#Requires -Version 5.1
<#
.SYNOPSIS
  开发态同步：bundle → 拷到运行目录 → 重启 broker → tail 日志。

.DESCRIPTION
  消灭手工循环（build/copy/kill/restart/log）。默认同步到当前 Junction 指向的版本目录，
  保持 install.ps1 安装的目录布局不变。PS 5.1 中文需 UTF-8 BOM（本文件已含）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-sync.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-sync.ps1 -InstallDir C:\Users\WH\figma-mcp-server
#>
param(
  [string]$InstallDir = 'C:\Users\WH\figma-mcp-server'
)

$ErrorActionPreference = 'Stop'

# --- 0. 构建（失败即停，输出透传） ---
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  pnpm run bundle
  if ($LASTEXITCODE -ne 0) { throw "bundle 失败 (exit $LASTEXITCODE)" }
  pnpm run plugin:build
  if ($LASTEXITCODE -ne 0) { throw "plugin:build 失败 (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

# --- 1. 解析目标目录（current Junction → versions\<x.y.z>；无 Junction = 旧平铺布局，直接用根目录） ---
$target = $InstallDir
$currentLink = Join-Path $InstallDir 'current'
if (Test-Path $currentLink) {
  $linkItem = Get-Item $currentLink -ErrorAction SilentlyContinue
  if ($linkItem -and $linkItem.LinkType -eq 'Junction') {
    $target = $linkItem.Target[0]
  }
}

# --- 2. 拷贝产物 ---
Copy-Item (Join-Path $PSScriptRoot '..\dist\bundle\index.mjs') (Join-Path $target 'index.mjs') -Force
Copy-Item (Join-Path $PSScriptRoot '..\dist\bundle\broker.mjs') (Join-Path $target 'broker.mjs') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $target 'plugin') | Out-Null
Copy-Item (Join-Path $PSScriptRoot '..\plugin\code.js') (Join-Path $target 'plugin\code.js') -Force
Write-Host "[ok] 产物已同步 -> $target" -ForegroundColor Green

# --- 3. 杀 broker（按端口找，兼容所有布局） ---
$listeners = netstat -ano | Select-String ':3056.*LISTENING'
foreach ($line in $listeners) {
  $pidToKill = ($line -split '\s+')[-1]
  if ($pidToKill -match '^\d+$') {
    taskkill /PID $pidToKill /F 2>&1 | Out-Null
    Write-Host "[ok] 已结束旧 broker (pid=$pidToKill)"
  }
}
# 顺带清孤儿 socket 桥/child（node 且命令行含 --fe-child）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*--fe-child=*'
} | ForEach-Object { taskkill /PID $_.ProcessId /F 2>&1 | Out-Null }

# --- 4. 隐藏重启 ---
Start-Process -FilePath 'node' -ArgumentList (Join-Path $target 'broker.mjs') -WorkingDirectory $target -WindowStyle Hidden
Write-Host "[ok] broker 已重启" -ForegroundColor Green

# --- 5. tail 日志 15 行 ---
Start-Sleep -Seconds 3
$logFile = Join-Path $env:LOCALAPPDATA 'figma-mcp-server\broker.log'
if (Test-Path $logFile) {
  Write-Host "--- broker.log (last 15) ---" -ForegroundColor Yellow
  Get-Content $logFile -Tail 15
}

Write-Host ""
Write-Host "动了 server+broker 层 -> 请 /mcp reconnect；插件层如也变 -> Figma 重开插件" -ForegroundColor Yellow
