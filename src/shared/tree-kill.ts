/**
 * 子进程**整棵树**终止 —— 全仓唯一实现（0.14.11，PM 卡「tree-kill 单一来源化」）。
 *
 * 为什么需要它：Windows 下裸 `child.kill()` 只杀**直接子进程**。
 * - `src/capabilities/shell.ts` 用 `powershell -Command` 起的 git/node/python 是孙进程；
 * - MCP 服务器经 `shell: isCmdBatch` 起（`.cmd`/`.bat` 必须过 `cmd.exe`）⇒ 裸 kill 只杀
 *   `cmd.exe`，真正的 `npx`/`node` 成孤儿继续活着（QD-R23 #1：`qd-r23-d2` 实测孙进程存活 2s+）。
 * 两者都落到同一形态：`taskkill /PID <pid> /T /F`（`/T` 连子树）。
 *
 * 本文件之前有**两份并行实现**（`shell.ts` 的 `killTree` 闭包、`mcp-controller.ts` 的
 * `killProcessTree`），行为相同、各自演进，属于已知重复。此处收敛为一份，两处改为引用；
 * 语义逐字保留（含非 win32 与 taskkill 缺失两条回落腿），不改任何可观察行为。
 *
 * 三个 spawn 属性是硬要求，不可在上提/搬运中丢失（`hidden-console-spawn.test.ts` 逐个
 * 调用块审计就靠它们）：
 * - `windowsHide: true` —— 否则每次 tree-kill 都会闪一个黑框（20261105 出资人真机反馈的同族）；
 * - `stdio: 'ignore'`   —— 收尸进程不产生输出，也不占用父进程的管道；
 * - `shell: false`      —— 安全红线：参数不经解释器，`pid` 无法被注入成命令。
 */

import { spawn, type ChildProcess } from 'node:child_process';

/** 只取终止所需的两个面，便于测试注入假 child（不必构造真 ChildProcess）。 */
export type Killable = Pick<ChildProcess, 'pid' | 'kill'>;

/** `taskkill` 的启动实现，默认 `spawn`；单测注入假实现以断言参数面（argv 与三个属性）。 */
type TaskkillSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; shell: false; windowsHide: true },
) => Pick<ChildProcess, 'on'>;

function safeKill(child: Killable): void {
  try {
    child.kill();
  } catch {
    /* 已退出：忽略 */
  }
}

/**
 * 终止整棵子进程树。
 *
 * 判定顺序（与上提前的两份实现逐字同序，勿调换）：
 * 1. win32 且有 pid ⇒ `taskkill /PID <pid> /T /F`；启动成功即 return（**不再**调用 `child.kill()`，
 *    那会与 taskkill 抢同一个 pid）；
 * 2. taskkill 启动抛错（`spawn` 同步抛）或异步 `error` 事件 ⇒ 回落 `child.kill()`；
 * 3. 非 win32 或 pid 未知（`null`/`undefined`）⇒ 直接回落 `child.kill()`。
 *
 * `pid == null` 一律当「不知道 pid」处理，**不**退化成杀 `0`/`-1` 之类，那在 POSIX 上会波及
 * 整个进程组。
 */
export function killProcessTree(
  child: Killable | null | undefined,
  spawnFn: TaskkillSpawn = spawn as unknown as TaskkillSpawn,
): void {
  if (!child) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid != null) {
    try {
      const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.on('error', () => safeKill(child));
      return;
    } catch {
      // taskkill 不可用 ⇒ 落到下面的直接 kill
    }
  }
  safeKill(child);
}
