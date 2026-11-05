# M3 真机 trace 采集入口（**只读**：不改 trace、不删、不碰 memories.db / config.json）
#
# 为什么要有这个包装：真机 trace 有**两个源**（实测，非推断）——
#   1) 开发树：<repo>\logs\trace\trace-<UTC日期>.jsonl   （进程 cwd = 仓库根）
#   2) 安装版：%APPDATA%\com.deepseek.studio\logs\trace\ （进程 cwd = app_data_dir）
# 两边各写各的，采集必须同时覆盖，否则「安装版用户用了 7 天」这件事会被漏掉。
#
# 用法：
#   pwsh -File scripts\m3-collect.ps1                 # 采集 + 归档 + 出每日分布
#   pwsh -File scripts\m3-collect.ps1 -SampleMin 20   # 样本充足阈值（任务数下限）
#   pwsh -File scripts\m3-collect.ps1 -Archive D:\m3 -Out D:\m3\daily

param(
  [string]$Archive = '',
  [string]$Out = '',
  [int]$SampleMin = 20
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$collector = Join-Path $repo 'tools\metrics\m3-collect.ts'
if (-not (Test-Path $collector)) {
  throw "collector not found: $collector"
}

$installTrace = Join-Path $env:APPDATA 'com.deepseek.studio\logs\trace'

$cliArgs = @('tsx', $collector, '--sample-min', "$SampleMin")
# 安装版 trace 源：始终传入（不存在时 collector 会显式列出「源不存在」，不静默当 0）
$cliArgs += @('--source', $installTrace)
if ($Archive -ne '') { $cliArgs += @('--archive', $Archive) }
if ($Out -ne '') { $cliArgs += @('--out', $Out) }

Write-Host "[m3-collect] repo   = $repo"
Write-Host "[m3-collect] source1= $(Join-Path $repo 'logs\trace')"
Write-Host "[m3-collect] source2= $installTrace (exists=$(Test-Path $installTrace))"

Push-Location $repo
try {
  & npx @cliArgs
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($code -ne 0) {
  Write-Host "[m3-collect] 采集未产出任何一天（exit=$code）——检查源目录是否存在"
}
exit $code
