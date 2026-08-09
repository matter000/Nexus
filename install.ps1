#!/usr/bin/env pwsh
# Nexus 安装脚本 — 一行命令安装（Windows）
#
# 用法：
#   irm https://raw.githubusercontent.com/matter000/Nexus/main/install.ps1 | iex
#   irm <url> | iex -Version 1.0.0          # 指定版本
#   irm <url> | iex -InstallDir D:\tools     # 自定义安装目录
#
# 行为：
#   1. 从 GitHub Release 下载 nexus-windows-x64.exe（独立可执行，无需 Bun）
#   2. 安装到 $HOME\.nexus\bin（默认）
#   3. 添加 PATH（用户级环境变量，幂等）
#   4. 运行 nexus --version 校验
#
# 说明：本脚本自身需要能被匿名访问（仓库转 public 后 raw URL 可用；
#       private 期间可先下载脚本本地执行，或使用 GitHub 加速代理前缀）。

param(
  [string]$Version = 'latest',
  [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'

# ─── 参数默认值 ─────────────────────────────────────────────────────────────
if (-not $InstallDir) {
  $InstallDir = Join-Path $HOME '.nexus\bin'
}
$ExeName = 'nexus-windows-x64.exe'
$DestPath = Join-Path $InstallDir $ExeName

# 资产下载 URL（GitHub Releases latest 固定路径）
$DownloadUrl = if ($Version -eq 'latest') {
  'https://github.com/matter000/Nexus/releases/latest/download/nexus-windows-x64.exe'
} else {
  $tag = if ($Version -match '^v') { $Version } else { "v$Version" }
  "https://github.com/matter000/Nexus/releases/download/$tag/nexus-windows-x64.exe"
}

# ─── 准备目录 ────────────────────────────────────────────────────────────────
if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
if (Test-Path $DestPath) {
  # 已存在的旧版本直接覆盖
  Remove-Item $DestPath -Force
}

# ─── 下载 ───────────────────────────────────────────────────────────────────
Write-Host "==> 下载 Nexus $Version ..." -ForegroundColor Cyan
Write-Host "    $DownloadUrl"

try {
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $DestPath -UseBasicParsing
} catch {
  Write-Error "下载失败: $($_.Exception.Message)"
  Write-Host "提示：国内网络可尝试先开启加速器，或使用代理前缀：" -ForegroundColor Yellow
  Write-Host "    https://githubproxy.cc/$DownloadUrl"
  exit 1
}

# ─── PATH（用户级，幂等） ──────────────────────────────────────────────────
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallDir*") {
  if ($userPath) {
    $newPath = "$userPath;$InstallDir"
  } else {
    $newPath = $InstallDir
  }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host "==> 已添加 PATH: $InstallDir（新终端生效）" -ForegroundColor Green
}

# 当前会话也临时生效（方便立即校验）
$env:Path = "$InstallDir;$env:Path"

# ─── 校验 ───────────────────────────────────────────────────────────────────
Write-Host "==> 校验安装 ..." -ForegroundColor Cyan
try {
  $ver = & $DestPath --version 2>&1 | Select-Object -First 1
  Write-Host "    安装成功: $ver" -ForegroundColor Green
  Write-Host ""
  Write-Host "nexus 已就绪！进入项目目录运行：" -ForegroundColor Cyan
  Write-Host "    cd your-project"
  Write-Host "    nexus"
  Write-Host ""
  Write-Host "首次运行会自动打开 API Key 配置面板（或先运行 nexus /config）。"
} catch {
  Write-Error "校验失败: $($_.Exception.Message)"
  Write-Host "可手动运行: & `"$DestPath`" --version"
  exit 1
}
