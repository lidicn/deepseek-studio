# =====================================================================
# 合流闸门 #3 一键自检（PM 用）
# 生成：2026-10-17 11:30 | 修订：改用「发卡时间基准」判越界，不再用 git status 全量
# 用法：powershell -File docs/PM/gate3-check.ps1
# 注意：刻意不含反斜杠；刻意不查 git status（工作区自 09:20 起从未 commit）
# =====================================================================

$ErrorActionPreference = 'Continue'
Set-Location 'E:/NAS/deepseek-studio'

# 本轮发卡基准时间（三席 11:08-11:12 发卡）。晚于此的改动才算本轮产物。
$GATE_BASE = Get-Date '2026-10-17 11:08:00'

$fail = 0
function Section($t) { Write-Host '' ; Write-Host ('=' * 68) ; Write-Host $t ; Write-Host ('=' * 68) }
function Bad($t)  { Write-Host ('  [FAIL] ' + $t) ; $script:fail++ }
function Ok($t)   { Write-Host ('  [ OK ] ' + $t) }
function Info($t) { Write-Host ('         ' + $t) }
function Warn($t) { Write-Host ('  [WARN] ' + $t) }

# 从一行文本里抠出第一个数字串（不用正则 d）
function FirstNum($line) {
    if (-not $line) { return -1 }
    $head = ($line -split 'pass')[0]
    $digits = $head -replace '[^0-9]', ''
    if ($digits -eq '') { return -1 }
    return [int]$digits
}

# 文件是否在基准时间之后被改过
function TouchedSince($path, $base) {
    if (-not (Test-Path $path)) { return $false }
    $m = (Get-Item $path).LastWriteTime
    return ($m -gt $base)
}

# ---------- 0a 冻结区（按 mtime 判，不按 git status）----------
Section 'CHECK 0a: 冻结区本轮是否被碰（按 mtime > 11:08 判）'
$frozen = @('src/host/engine/model-engine.ts','src/shared/harness-metrics.ts')
$hit = $false
foreach ($f in $frozen) {
    if (TouchedSince $f $GATE_BASE) {
        Bad ('冻结区本轮被改: ' + $f)
        $hit = $true
    } else {
        $mt = (Get-Item $f).LastWriteTime.ToString('MM-dd HH:mm')
        Ok ('{0}  未动（mtime {1}）' -f $f, $mt)
    }
}
if (-not $hit) { Info '（注：它们可能在 git status 里显示 M 或 ??，那是 11:08 之前的历史改动，不算越界）' }

# ---------- 0b package.json 只多一行 ----------
Section 'CHECK 0b: 席3 是否只给 package.json 加了 metrics:report 一行'
$pkgDiff = git diff -- package.json
$added = @()
$removed = @()
foreach ($ln in $pkgDiff) {
    if ($ln.StartsWith('+++') -or $ln.StartsWith('---')) { continue }
    if ($ln.StartsWith('+')) { $added += $ln }
    elseif ($ln.StartsWith('-')) { $removed += $ln }
}
# 前两轮已知的合法新增（不是本轮席3 的）
$known = @('tauri:build', 'eval:golden', 'pi-agent-core')
$newOnes = @()
foreach ($a in $added) {
    $isKnown = $false
    foreach ($k in $known) { if ($a.Contains($k)) { $isKnown = $true; break } }
    if (-not $isKnown) { $newOnes += $a }
}
Info ('package.json 累计新增 ' + $added.Count + ' 行；其中前两轮已知 ' + ($added.Count - $newOnes.Count) + ' 行')
if ($newOnes.Count -eq 0) {
    Warn '本轮未见 package.json 新增（席3 可能还没改，或已交付但未加 script）'
} elseif ($newOnes.Count -eq 1 -and $newOnes[0].Contains('metrics:report')) {
    Ok '本轮仅新增 metrics:report 一行'
} else {
    Bad ('本轮新增了 ' + $newOnes.Count + ' 行，超出授权:')
    $newOnes | ForEach-Object { Info ('  ' + $_.Trim()) }
}

# ---------- 0c task-loop 不依赖实现 ----------
Section 'CHECK 0c: 席1 是否偷依赖实现（task-loop.ts 不应 import createWebEngine）'
$tl = 'src/host/kernel/task-loop.ts'
if (Test-Path $tl) {
    $hits = Select-String -Path $tl -Pattern 'createWebEngine' -SimpleMatch
    if ($hits) { Bad 'task-loop.ts 引用了 createWebEngine'; $hits | ForEach-Object { Info ($_.LineNumber.ToString() + ': ' + $_.Line.Trim()) } }
    else { Ok 'task-loop.ts 未引用 createWebEngine' }
    $eng = Select-String -Path $tl -Pattern 'ModelEngine' -SimpleMatch
    if ($eng) { Ok ('引用 ModelEngine 接口 ' + $eng.Count + ' 处') } else { Bad 'task-loop.ts 未引用 ModelEngine 接口' }
} else { Bad ('task-loop.ts 不存在：' + $tl) }

# ---------- 1 三席产物 ----------
Section 'CHECK 1: 三席独占文件是否落地'
$expect = @(
  'src/host/kernel/task-loop.ts',
  'tests/desktop/kernel-task-loop.test.ts',
  'tests/desktop/web-engine-transport.test.ts',
  'tools/metrics/report.ts',
  'tests/desktop/metrics-report.test.ts'
)
foreach ($f in $expect) {
    if (Test-Path $f) { $fi = Get-Item $f ; Ok ('{0}  ({1}B / {2} 行)' -f $f, $fi.Length, (Get-Content $f).Count) }
    else { Bad ('缺失: ' + $f) }
}

# ---------- 2 长期禁区（按 mtime）----------
Section 'CHECK 2: 长期禁区本轮是否被碰（按 mtime > 11:08 判）'
$forbidden = @('src/inject/main-world-interceptor.ts','src/host/agent-loop.ts','src/host/bot/types.ts')
foreach ($f in $forbidden) {
    if (TouchedSince $f $GATE_BASE) { Bad ('长期禁区本轮被改: ' + $f) }
    else {
        $mt = (Get-Item $f).LastWriteTime.ToString('MM-dd HH:mm')
        Ok ('{0}  未动（mtime {1}）' -f $f, $mt)
    }
}

# ---------- 3a typecheck ----------
Section 'CHECK 3a: typecheck'
npm run typecheck 2>&1 | Select-Object -Last 8 | ForEach-Object { Info $_ }
if ($LASTEXITCODE -eq 0) { Ok 'typecheck EXIT=0' } else { Bad ('typecheck EXIT=' + $LASTEXITCODE) }

# ---------- 3b eval:golden ----------
Section 'CHECK 3b: eval:golden（期望 18/18）'
npm run eval:golden 2>&1 | Select-Object -Last 6 | ForEach-Object { Info $_ }
if ($LASTEXITCODE -eq 0) { Ok 'eval:golden EXIT=0' } else { Bad ('eval:golden EXIT=' + $LASTEXITCODE) }

# ---------- 3c 全量测试 ----------
Section 'CHECK 3c: 全量测试（期望 >=79 files / >=827 tests）'
Write-Host '  （约 90-190s，请等待...）'
$vt = npx vitest run 2>&1
$vt | Select-Object -Last 12 | ForEach-Object { Info $_ }
$fileLine = ($vt | Where-Object { $_ -match 'Test Files' } | Select-Object -Last 1)
$nf = FirstNum $fileLine
if ($nf -ge 0) {
    if ($nf -ge 79) { Ok ('测试文件数 ' + $nf + ' >= 79') } else { Bad ('测试文件数 ' + $nf + ' < 79（三席各应 +1）') }
} else { Bad '无法解析 Test Files 行' }
$testLine = ($vt | Where-Object { $_ -match 'Tests' -and $_ -notmatch 'Test Files' } | Select-Object -Last 1)
$nt = FirstNum $testLine
if ($nt -ge 0) {
    if ($nt -ge 827) { Ok ('用例数 ' + $nt + ' >= 827') } else { Bad ('用例数 ' + $nt + ' < 827') }
} else { Bad '无法解析 Tests 行' }
if ($vt -match 'failed') { Bad '输出中出现 failed' }

# ---------- 汇总 ----------
Section 'RESULT'
if ($fail -eq 0) { Write-Host '  GATE3_PASS  全部通过，可更新 STATE/DECISIONS 并发第四轮' }
else { Write-Host ('  GATE3_FAIL  失败 ' + $fail + ' 项，按 [FAIL] 逐条定位，不要开下一轮') }