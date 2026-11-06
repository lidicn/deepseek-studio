// QD-R23-D2（泄漏负控）：MCP 收尸 = 单次 proc.kill()（cleanup / disconnectServer /
// testConnection finally 三条腿），Windows .cmd/.bat 走 shell 包裹 → 孙进程孤儿化；
// 叠加 D4（宿主退出无 disconnectAll 钩子）→ 每次宿主重启累积孤儿。
//
// 本负控（仅 Windows 有效）：临时 .cmd 启动 60s 的 node 孙进程（PID 落盘），
// 对直接进程 kill，断言孙进程仍存活。修复前恒红（证实无 tree-kill）；
// 团队实现 tree-kill（taskkill /T /F 或等价物）后改断言为 !alive 转正控。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('QD-R23-D2 MCP 孙进程孤儿 负控', () => {
  it('对 .cmd 直接进程 kill 后孙进程仍存活（证实无 tree-kill）', async () => {
    if (process.platform !== 'win32') {
      console.log('skip：仅 Windows 有效（POSIX 无 shell 包裹语义，另建用例）');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-orphan-'));
    const pidFile = path.join(dir, 'child-pid.txt');
    const cmd = path.join(dir, 'spawner.cmd');
    const JS = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},60000);";
    fs.writeFileSync(
      cmd,
      [
        '@echo off',
        'node -e ' + JSON.stringify(JS) + ' ' + JSON.stringify(pidFile),
        'timeout /t 59 >nul',
      ].join('\n'),
      'utf8',
    );

    // 与 isCmdBatch 同款语义：.cmd 走 shell 包裹（Node 直接 CreateProcess .cmd 会 EINVAL）
    const p = spawn(cmd, [], { stdio: ['ignore', 'ignore', 'ignore'], shell: true, windowsHide: true });
    let childPid = 0;
    for (let i = 0; i < 25; i += 1) {
      if (fs.existsSync(pidFile)) {
        childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        break;
      }
      await sleep(200);
    }
    expect(childPid, '孙进程应已起来（PID 落盘）').toBeGreaterThan(0);

    p.kill(); // 当前 cleanup 语义：只杀直接进程（cmd.exe）
    await sleep(2000);

    let alive = false;
    try {
      process.kill(childPid, 0);
      alive = true;
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === 'EPERM';
    }
    expect(alive, '孙进程已被收掉（说明 tree-kill 已生效，本负控可转正控）').toBe(true);

    try { process.kill(childPid); } catch { /* 已退出 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});