/**
 * tests/desktop/qd-r23-orphan-reaper.test.ts
 *
 * QD-R23 #1（MCP 子进程收尸）的**闸内**验收用例。
 *
 * 来由（PM 裁定 ③ 走 (b)）：原始负控在 `docs/审计报告/QD/复现用例/qd-r23-d4-*.test.ts`，
 * 那是**独立跑批**（`qd-r23-vitest.config.ts`），**不在 `vitest.config.ts` 的 include 内**
 * ⇒ 不进全量闸 = 没进回归。本文件是它的闸内副本，原文件保留并加注指向这里。
 *
 * 覆盖四件事（对应 PM 卡的 ①②③④）：
 *   1. **tree-kill 范式**：`.cmd` 起的 MCP 只杀 cmd.exe ⇒ 真进程成孤儿；必须 `taskkill /T /F`。
 *   2. **退出钩子收尸**：孤儿防护 / SIGTERM 两条腿在 `exit(0)` 前都必须先调 `beforeExit`。
 *   3. **`disconnectAll()` 真的有调用方**（原 d4 死代码负控转正控）。
 *   4. **`testConnection` 的 `__test__` 子进程登记进收尸可达集合**（它从不进 connections map）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONTROLLER = path.join(REPO_ROOT, 'src', 'host', 'mcp-controller.ts');
const MAIN_TS = path.join(REPO_ROOT, 'src', 'api', 'main.ts');

function walkTs(dirPath: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dirPath)) {
    if (name === 'node_modules' || name === 'dist' || name === 'archive' || name === '.codegraph') continue;
    const full = path.join(dirPath, name);
    if (fs.statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('QD-R23 #1 · MCP 子进程收尸', () => {
  const controllerSrc = fs.readFileSync(CONTROLLER, 'utf8');
  const mainSrc = fs.readFileSync(MAIN_TS, 'utf8');

  it('装置自检：两个被测文件都读到了真内容（防路径写错导致全绿）', () => {
    expect(controllerSrc.length).toBeGreaterThan(10_000);
    expect(mainSrc.length).toBeGreaterThan(2_000);
    // 关键符号必须存在，否则下面的断言是在空跑
    expect(controllerSrc).toContain('export function killProcessTree(');
    expect(mainSrc).toContain('function installOrphanGuard(');
  });

  it('① tree-kill：MCP 的 kill 都走 killProcessTree（不再有裸 kill 留下 cmd 的孙子）', () => {
    // 装置自检：范式本体必须在用 taskkill /T
    expect(controllerSrc).toMatch(/spawn\('taskkill', \['\/PID', String\(pid\), '\/T', '\/F'\]/);
    // 四处历史裸 kill 全部消失
    expect(controllerSrc).not.toMatch(/\bproc\.kill\(\)/);
    expect(controllerSrc).not.toMatch(/conn\.process\?\.kill\(\)/);
    expect(controllerSrc).not.toMatch(/\bspawnedProc\.kill\(\)/);
    // 且调用点确实落在 tree-kill 上
    const treeKills = controllerSrc.match(/killProcessTree\(/g) ?? [];
    expect(treeKills.length).toBeGreaterThanOrEqual(4);

    // 🔴 结构断言（这条是被一次失败演示逼出来的盲区，见交卷说明）：
    // 只断「没有裸 kill」不够 —— 把 killProcessTree **函数体**改成先裸 kill 再 early return，
    // 上面那几条断言全绿、缺陷却回来了。必须直接断函数体的名义：
    //   · 函数内**不得出现任何 `child.kill()` 之外的提前返回**（除 taskkill 失败回落外）
    //   · `taskkill` 必须是函数体的**第一条实际动作**（在 `child.kill()` 回落之前）
    const bodyStart = controllerSrc.indexOf('export function killProcessTree(');
    expect(bodyStart).toBeGreaterThan(-1);
    const bodyEnd = controllerSrc.indexOf('\n}\n', bodyStart);
    const body = controllerSrc.slice(bodyStart, bodyEnd);
    const taskkillIdx = body.indexOf("spawn('taskkill'");
    const fallbackIdx = body.indexOf('child.kill();');
    expect(taskkillIdx, '函数体内必须调 taskkill').toBeGreaterThan(-1);
    // taskkill 必须在回落之前（顺序反了 = 先裸杀，树杀形同虚设）
    expect(taskkillIdx).toBeLessThan(fallbackIdx);
    // 函数体内除定义处外不得有 `return;` 出现在 taskkill 之前（防 early return 短路）
    const beforeTaskkill = body.slice(0, taskkillIdx);
    expect(beforeTaskkill).not.toMatch(/child\.kill\(/);
    expect(beforeTaskkill).not.toMatch(/\n\s*return;\s*\n/);
  });

  it('② 退出钩子：两条腿都在 exit(0) 前调 beforeExit 收尸', () => {
    // 统一出口存在，且 exit 只在这个出口里出现一次
    expect(mainSrc).toContain('const exitWithCleanup = (): void => {');
    expect(mainSrc).toContain('d.beforeExit?.();');
    // 孤儿防护那条腿
    expect(mainSrc).toMatch(/父进程 \$\{ppid0\} 消失[^]*?exitWithCleanup\(\)/);
    // 信号那条腿
    expect(mainSrc).toMatch(/for \(const sig of \['SIGTERM', 'SIGBREAK'\][^]*?exitWithCleanup\(\)/);
    // 真回归：退出钩子不得绕过收尸直接裸退
    expect(mainSrc).not.toMatch(/d\.exit\(0\);\s*\n\s*\}\s*,?\s*$/m);
  });

  it('③ disconnectAll() 在 src 有真实调用方（原 d4 死代码负控 → 正控）', () => {
    let callers = 0;
    for (const f of walkTs(path.join(REPO_ROOT, 'src'))) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('disconnectAll()')) continue;
        if (f.endsWith('mcp-controller.ts') && line.includes('disconnectAll():')) continue; // 定义行
        callers += 1;
      }
    }
    expect(callers, 'disconnectAll() 无调用方：宿主退出不收尸 MCP 子进程').toBeGreaterThanOrEqual(1);
  });

  it('④ testConnection 的临时子进程登记进收尸可达集合', () => {
    // PM 实测：__test__ 连接从不 connections.set() ⇒ 必须另有登记表
    expect(controllerSrc).toContain('const adHocChildren = new Set<ChildProcess>();');
    expect(controllerSrc).toMatch(/spawnedProc = proc;\s*\n\s*\/\/[^\n]*\n\s*adHocChildren\.add\(proc\);/);
    expect(controllerSrc).toContain('export function killAllAdHocChildren(');
    // finally 里收尸后要移除登记（防集合长期膨胀）
    expect(controllerSrc).toMatch(/adHocChildren\.delete\(spawnedProc\)/);
    // main.ts 的 beforeExit 必须同时覆盖两条腿
    expect(mainSrc).toContain('disconnectAll()');
    expect(mainSrc).toContain('killAllAdHocChildren()');
  });
});
