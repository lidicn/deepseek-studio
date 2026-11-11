/**
 * tests/desktop/release-notes-roundtrip.test.ts
 *
 * step16「Patch draft release body」的**执行面空跑**（K-2，2026-11-11 第二版）。
 *
 * 上一版是 node 复刻管线 → PM 裁定不采纳：**被测物必须是 workflow 原文**，
 * 复刻件再绿也证明不了那段 pwsh 不崩（自指/零信息族）。
 *
 * 本版做法同 R-1 sim：**从 release.yml 里抽出该 step 的 `run:` 原文**，
 * 只替身两条外部依赖（`Invoke-RestMethod` → `Invoke-Stub`、`Start-Sleep` 秒级 → 毫秒级），
 * **其余一字不动**，然后真跑 pwsh，对三种接口态断言**行为**：
 *   equal    → exit 0，且打印 verified；
 *   mismatch → exit≠0，且**三件套在 throw 之前**打全（顺序断言，不靠"日志里没看到"）；
 *   empty    → exit≠0，且**不许在 `.Trim()` 上炸**，必须先打"空回读"诊断。
 *
 * 判据是行为，不是内部实现串 ⇒ Gate 重写 step16 内部（by-id 回读／::error:: 注解）后这枚仍应成立。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WF = path.join(ROOT, '.github', 'workflows', 'release.yml');
const TAG = 'v0.14.15';

/** 从 release.yml 抽出 `- name: Patch draft release body` 那个 step 的 run: | 原文。 */
function extractPatchRun(): string {
  const lines = fs.readFileSync(WF, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('- name: Patch draft release body'));
  if (start < 0) throw new Error('release.yml 里找不到 Patch draft release body 步');
  const runIdx = lines.findIndex((l, i) => i > start && /^\s*run:\s*\|/.test(l));
  if (runIdx < 0) throw new Error('该步没有 run: | 块');
  const baseIndent = lines[runIdx].match(/^\s*/)![0].length;
  const body: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    const indent = line.match(/^\s*/)![0].length;
    if (indent <= baseIndent) break;
    body.push(line.slice(Math.min(indent, baseIndent + 2)));
  }
  return body.join('\n');
}

const STUB = `
$script:ExpectedBody = ((Get-Content "docs/release-notes-$env:TAG_NAME.md" -Raw).Trim()) -replace "\`r\`n", "\`n"
$script:ReadCalls = 0
# 替身 API：PATCH 存下写入体；回读（列表或 by-id 都算一次）按用例态返回。
# LIST_EMPTY_FIRST=N ⇒ 前 N 次**回读**返回空（复刻 GitHub 列表/by-id 的最终一致性窗口）。
function Invoke-Stub {
  param($Headers, $Uri, $Method, $ContentType, $Body)
  if ($Method -eq 'Patch') {
    $script:PatchedBody = ($Body | ConvertFrom-Json).body
    return [pscustomobject]@{ id = 1; tag_name = $env:TAG_NAME; draft = $true; body = $script:PatchedBody }
  }
  $script:ReadCalls += 1
  $emptyFirst = [int]$env:LIST_EMPTY_FIRST
  # byid-empty-patch-ok：查询端点（列表/by-id）一律返回空，只有 PATCH 返回体带 body。
  # 这是 v3 poll1 兜底路径的唯一覆盖点（PM 2026-11-11 ②：兜底成功后若不复位粘滞标志，
  # 会出现"同一轮既打印 verified 又判失败"）。
  # byid-empty-patch-ok：**首查成功**（返回草稿对象，模拟 step15 刚建好）、此后查询端点一律空，
  # 只有 PATCH 返回体带 body ⇒ 逼出 poll1 的"用 PATCH 返回体兜底"那条路径。
  if ($env:SIM_STATE -eq 'byid-empty-patch-ok') {
    if ($script:ReadCalls -eq 1) { return [pscustomobject]@{ id = 1; tag_name = $env:TAG_NAME; draft = $true; body = $script:ExpectedBody } }
    return @()
  }
  if ($env:SIM_STATE -eq 'empty') { return @() }
  if ($env:SIM_STATE -eq 'empty-then-equal' -and $script:ReadCalls -le $emptyFirst) { return @() }
  if ($env:SIM_STATE -eq 'empty-then-equal') {
    return [pscustomobject]@{ id = 1; tag_name = $env:TAG_NAME; draft = $true; body = $script:ExpectedBody }
  }
  switch ($env:SIM_STATE) {
    'equal'    { return [pscustomobject]@{ id = 1; tag_name = $env:TAG_NAME; draft = $true; body = $script:ExpectedBody } }
    # 模拟"正文被上游变换"：把句号换成感叹号（长度不变、内容变 ⇒ 必须判不等）
    'mismatch' { return [pscustomobject]@{ id = 1; tag_name = $env:TAG_NAME; draft = $true; body = ($script:ExpectedBody -replace '。', '!') } }
    default    { throw "unknown SIM_STATE=$env:SIM_STATE" }
  }
}
`;

function runState(
  state: 'equal' | 'mismatch' | 'empty' | 'empty-then-equal' | 'byid-empty-patch-ok',
  listEmptyFirst = 0,
  draftId = '1',
): { code: number; out: string } {
  const raw = extractPatchRun()
    // 替身：只换外部依赖调用，其余原文不动。
    .replace(/Invoke-RestMethod/g, 'Invoke-Stub')
    // GitHub 表达式在本地不会展开：把 step15 的 id 输出替换成桩里可控的值，
    // 这样"id 拿不到"这条真实分支才测得到（不替换的话它永远是字面量、永远走 by-id 成功）。
    .replace(/'\$\{\{\s*steps\.create_release\.outputs\.id\s*\}\}'/g, '$env:DRAFT_ID')
    // 轮询里的秒级等待改成毫秒级（仅 harness 提速，不改变控制流）。
    .replace(/Start-Sleep -Seconds \(\$poll \* 2\)/g, 'Start-Sleep -Milliseconds 1');
  expect(raw.includes('Invoke-Stub'), '抽出的原文里没有 Invoke-RestMethod，替身没生效').toBe(true);

  const dir = path.join(os.tmpdir(), `patchstep-${process.pid}-${state}`);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'step16.ps1');
  fs.writeFileSync(script, `${STUB}\n${raw}\n`, 'utf8');
  try {
    const out = execFileSync('pwsh', ['-NoProfile', '-File', script], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TAG_NAME: TAG,
        REPOSITORY: 'owner/repo',
        GH_TOKEN: 'stub',
        SIM_STATE: state,
        LIST_EMPTY_FIRST: String(listEmptyFirst),
        DRAFT_ID: draftId,
      },
      timeout: 90_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('step16 原文空跑（K-2 执行面判据）', () => {
  it('equal：回读等值 ⇒ exit 0 且打印 verified', () => {
    const r = runState('equal');
    expect(r.code, `等值态应 exit 0，实际 ${r.code}\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/verified|patched and verified/i);
  });

  it('mismatch：三件套必须在 throw 之前打全（顺序断言）', () => {
    const r = runState('mismatch');
    expect(r.code, `不等态应 exit≠0，实际 ${r.code}\n${r.out}`).not.toBe(0);
    const iExp = r.out.indexOf('expected_len=');
    const iAct = r.out.indexOf('actual_len=');
    const iDiff = r.out.indexOf('firstDiff=');
    expect(iExp, '缺 expected_len').toBeGreaterThanOrEqual(0);
    expect(iAct, '缺 actual_len').toBeGreaterThanOrEqual(0);
    expect(iDiff, '缺 firstDiff').toBeGreaterThanOrEqual(0);
    // 顺序：三件套都要在"最终 throw 的文案"之前出现，否则真因格下诊断仍会丢。
    const throwIdx = r.out.indexOf('!= notes file after PATCH');
    if (throwIdx >= 0) {
      expect(iExp, 'expected_len 出现在 throw 之后').toBeLessThan(throwIdx);
      expect(iDiff, 'firstDiff 出现在 throw 之后').toBeLessThan(throwIdx);
    }
  });

  it('empty：回读为空时不许在 .Trim() 上炸，必须先打空回读诊断', () => {
    const r = runState('empty');
    expect(r.code, `空回读态应 exit≠0，实际 ${r.code}\n${r.out}`).not.toBe(0);
    // 现场病根：旧码在 $rel2.body.Trim() 上抛 "不能对值为 Null 的表达式调用方法"，
    // 诊断全丢。这里断"不许出现该 null 解引用错"，且必须出现自定义的空回读诊断。
    expect(r.out, '仍在 .Trim() 上崩（null 解引用），诊断会全丢').not.toMatch(/Null 的表达式调用方法|null-valued expression/i);
    expect(r.out, '缺空回读诊断（应含 rel2 / null / empty 字样）').toMatch(/rel2|null|empty/i);
  });

  it('先空后对：列表首次回读为空、次回即等值 ⇒ 必须判成功，不许抛（PM 实跑 case1）', () => {
    // 这是 GitHub 列表接口最终一致性的**正常形态**：step15 建草稿与 step16 首查同一秒交接，
    // 首查很可能拿到空列表。旧码/带粘滞标志的改法会"明明相等却抛"——
    // 现场表征是日志里同时出现 "patched and verified" 和 throw，自相矛盾。
    const r = runState('empty-then-equal', 1);
    expect(
      r.code,
      `先空后对应放行，实际 exit=${r.code}\n——粘滞标志（$rel2Empty 置位后永不复位）或首查无重试都会在这里红\n${r.out}`,
    ).toBe(0);
    expect(r.out).toMatch(/verified/i);
    expect(r.out, '同时出现 verified 与 throw ⇒ 成功路径被自己判失败').not.toMatch(/not found after|!= notes file after PATCH/);
  });

  it('兜底路径：查询端点全空、只有 PATCH 返回体有 body ⇒ 必须 exit 0 且 verified（不许"说成功又判失败"）', () => {
    // PM 2026-11-11 ②：v3 的 poll1 兜底分支在 `$lastEmpty = $true` 之后执行，
    // 兜底成功后若不复位 ⇒ 同一轮既打印 verified 又 throw（exit=1）。
    // 这枚现在应当**红**（Gate 未修），修完转绿。不许改松、不许标"预期红"。
    const r = runState('byid-empty-patch-ok');
    expect(
      r.code,
      `兜底成功应 exit 0，实际 ${r.code}\n——${'`$lastEmpty'} 在兜底后未复位 ⇒ "verified 后仍 throw"\n${r.out}`,
    ).toBe(0);
    expect(r.out).toMatch(/verified/i);
    expect(
      r.out,
      '同一轮既 verified 又判失败（自相矛盾）',
    ).not.toMatch(/is null or body is null after|not found after/);
  });
  it('第 6 枚 list-first-empty：id 拿不到 + 列表首查空 + 次查有 ⇒ 必须 exit 0（首查无重试格）', () => {
    // PM 2026-11-11 ④：draftId 为空串（action 未输出 id）时走列表回落，而回落是"一次定生死"。
    // GitHub 列表接口有最终一致性延迟，首查空是正常形态 ⇒ 必须重试，不许首查即 throw。
    const r = runState('empty-then-equal', 1, '');
    expect(
      r.code,
      `首查空、次查有应放行，实际 exit=${r.code}\n——列表回落首查一次不中即 throw（L383）\n${r.out}`,
    ).toBe(0);
    expect(r.out).toMatch(/verified/i);
  });
  it('第 7 枚 draftid-selfcheck：step16 必须把 draftId 的实际值打进输出（runner 上 id 存在性的唯一证据）', () => {
    // PM ②：本地/离线跑时 $draftId 是字面量非空串，只有 runner 会展开 ⇒ 本地"永远走 by-id"是假象。
    // 因此必须靠输出里的 draftId= 这一行，才能在 0.14.16 首 run 的日志/注解里看出 id 到底有没有。
    const r = runState('equal');
    expect(r.out, '缺 draftId 自检行（下一发仍无法判断 id 是否存在）').toMatch(/draftId=\S+/);
  });
});