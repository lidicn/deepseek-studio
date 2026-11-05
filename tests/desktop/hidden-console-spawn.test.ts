/**
 * 子进程「不弹控制台窗口」回归断言（20261105 出资人真机反馈：**安装版启动时弹出一个
 * 蓝色 PowerShell 窗口**）。
 *
 * 根因（Rust 侧，启动路径）：`do_spawn()` 每轮首启（`restarts == 0`）都会调
 * `terminate_host_by_cmdline()` 清理上一轮遗留宿主，而它直接 `Command::new("powershell")`
 * 且**没有** CREATE_NO_WINDOW —— GUI 进程拉 console 程序时 Windows 会为它建一个可见
 * 控制台窗口（powershell 默认蓝底，正是用户看到的那一个）。netstat / taskkill 同类
 * （一闪而过的黑框）。
 *
 * 修法：Rust 侧所有 console 程序统一走 `console_command()`（内置 CREATE_NO_WINDOW）；
 * TS 侧 host 运行时所有 spawn/exec/execFile 补 `windowsHide: true`。
 *
 * 负控：删掉任一处 `windowsHide: true`（或把 Rust 的 `console_command` 换回
 * `Command::new`），本文件必红。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { pickFolderViaDialog } from '../../src/host/folder-picker';

const repoRoot = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

/** 取某个调用点从 marker 到 endMarker 之间的参数文本（只在这一段里找 windowsHide）。 */
function callBlock(source: string, marker: string, endMarker: string, occurrence = 1): string {
  let from = -1;
  for (let i = 0; i < occurrence; i += 1) {
    from = source.indexOf(marker, from + 1);
    expect(from, `call site not found: ${marker} (#${occurrence})`).toBeGreaterThanOrEqual(0);
  }
  const rest = source.slice(from);
  const end = rest.indexOf(endMarker);
  expect(end, `end marker not found after: ${marker}`).toBeGreaterThan(0);
  return rest.slice(0, end);
}

/** host 运行时里会拉子进程的 TS 站点（审计清单，逐个必须 windowsHide）。 */
const TS_SITES: Array<{ file: string; marker: string; end: string; occurrence?: number; label: string }> = [
  { file: 'src/capabilities/shell.ts', marker: 'spawn(argv[0], argv.slice(1), {', end: '});', label: 'shell 能力主进程' },
  { file: 'src/capabilities/shell.ts', marker: "spawn('taskkill'", end: '});', label: 'shell 能力收尸 taskkill' },
  { file: 'src/capabilities/test-runner.ts', marker: 'const child = spawn(argv[0], argv.slice(1), {', end: '});', label: 'test-runner' },
  { file: 'src/host/sandbox-executor.ts', marker: 'execFile(pythonCmd, [scriptPath], {', end: '}, (error,', label: 'sandbox python' },
  { file: 'src/host/automation.ts', marker: 'exec(task.payload.command!', end: ', (err,', label: 'automation shell 任务' },
  { file: 'src/host/mcp-controller.ts', marker: 'const proc = spawn(config.command, config.args ?? [], {', end: '});', occurrence: 1, label: 'mcp connectStdio' },
  { file: 'src/host/mcp-controller.ts', marker: 'const proc = spawn(config.command, config.args ?? [], {', end: '});', occurrence: 2, label: 'mcp testConnection' },
  { file: 'src/host/folder-picker.ts', marker: "spawnFn('powershell.exe'", end: '});', label: '原生目录选择 powershell' },
];

describe('子进程不弹控制台：TS host 侧', () => {
  for (const site of TS_SITES) {
    it(`${site.label}（${site.file}）带 windowsHide: true`, () => {
      const block = callBlock(read(site.file), site.marker, site.end, site.occurrence ?? 1);
      expect(block).toContain('windowsHide: true');
    });
  }

  it('目录选择：注入 spawn 后实际收到的选项里有 windowsHide: true（行为层，不是源码文本）', async () => {
    let captured: { cmd: string; opts: Record<string, unknown> } | null = null;
    const child = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { /* noop */ };
    setTimeout(() => child.emit('close'), 0);

    const spawnFn = ((cmd: string, _args: string[], opts: Record<string, unknown>) => {
      captured = { cmd, opts };
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const result = await pickFolderViaDialog({ spawnFn, timeoutMs: 500 });
    expect(result).toBeNull(); // 空输出 → null（用户取消语义不变）
    expect(captured).not.toBeNull();
    expect(captured!.cmd).toBe('powershell.exe');
    expect(captured!.opts.windowsHide).toBe(true);
    expect(captured!.opts.shell).toBe(false); // 安全红线不变
  });

  it('清单完整性：host 运行时凡是引 child_process 的文件都在审计清单里，且 windowsHide 数与 spawn 数一致', () => {
    const expected: Record<string, number> = {
      'src/capabilities/shell.ts': 2,
      'src/capabilities/test-runner.ts': 1,
      'src/host/sandbox-executor.ts': 1,
      'src/host/automation.ts': 1,
      'src/host/mcp-controller.ts': 2,
      'src/host/folder-picker.ts': 1,
      'src/host/native-consent.ts': 1,
    };
    const roots = ['src/host', 'src/api', 'src/bridge', 'src/capabilities', 'src/shared', 'src/types'];
    const found: string[] = [];
    for (const root of roots) {
      const abs = path.join(repoRoot, root);
      if (!fs.existsSync(abs)) continue;
      for (const rel of fs.readdirSync(abs, { recursive: true }) as string[]) {
        if (!rel.endsWith('.ts')) continue;
        const full = path.join(abs, rel);
        const source = fs.readFileSync(full, 'utf-8');
        if (!/from 'node:child_process'|import\('node:child_process'\)|require\('node:child_process'\)/.test(source)) continue;
        found.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
      }
    }
    // 新增任何引 child_process 的文件都必须先进清单（否则本断言红 → 逼一次人工审计）
    expect(found.sort()).toEqual(Object.keys(expected).sort());
    for (const [file, count] of Object.entries(expected)) {
      const hits = read(file).match(/windowsHide:\s*true/g) ?? [];
      expect(hits.length, `${file} 的 windowsHide 数应为 ${count}`).toBe(count);
    }
  });
});

describe('子进程不弹控制台：Rust 侧（启动路径根因）', () => {
  const rust = read('src-tauri/src/sidecar.rs');

  it('console 程序统一走 console_command()（内置 CREATE_NO_WINDOW）', () => {
    expect(rust).toMatch(/fn console_command\(program: &str\) -> Command \{\s*let mut cmd = Command::new\(program\);\s*win_creation_flags\(&mut cmd\);/);
  });

  it('powershell / netstat / taskkill 不再裸 Command::new（否则每次启动弹蓝窗/黑框）', () => {
    for (const program of ['powershell', 'netstat', 'taskkill']) {
      expect(rust).not.toContain(`Command::new("${program}")`);
    }
    expect(rust).toContain('console_command("powershell")');
    expect(rust).toContain('console_command("netstat")');
    expect(rust).toContain('console_command("taskkill")');
  });

  it('启动路径的首轮清理仍然存在（只是现在隐藏窗口）', () => {
    expect(rust).toContain('if self.restarts == 0 {');
    expect(rust).toContain('terminate_host_by_cmdline();');
  });

  it('node 子进程（宿主）仍带 CREATE_NO_WINDOW', () => {
    expect(rust).toContain('win_creation_flags(&mut cmd);');
    expect(rust).toContain('const CREATE_NO_WINDOW: u32 = 0x0800_0000;');
  });
});
