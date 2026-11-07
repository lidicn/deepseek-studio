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

/**
 * 剥掉注释行后的源码 —— **本文件的计数/存在性判据一律只看代码，不看注释**。
 *
 * 为什么必须统一：`windowsHide` 计数那条曾经把注释文本也算进去，于是「在头注释里解释
 * 为什么要这个属性」反而让守卫变红（2026-11-07 真发生：为了迁就判据去改文档措辞）。
 * 同族第 27 枚——**判据的读数面必须与它想表达的东西同口径**；否则下一个人加注释就莫名判红，
 * 而且没人会怀疑「写文档」能弄坏一条安全断言。
 *
 * 只剥整行注释（`//`、JSDoc 的 `*` 起始行），不处理行尾注释 —— 本文件涉及的两个属性
 * 在选项对象里，行尾注释不参与计数，简化处理不会放过任何真漏。
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** host 运行时里会拉子进程的 TS 站点（审计清单，逐个必须 windowsHide）。 */const TS_SITES: Array<{ file: string; marker: string; end: string; occurrence?: number; label: string }> = [
  { file: 'src/capabilities/shell.ts', marker: 'spawn(argv[0], argv.slice(1), {', end: '});', label: 'shell 能力主进程' },
  // 0.14.11 tree-kill 单一来源化：shell 的收尸 taskkill 与 MCP 的收尸 taskkill 合并为
  // `src/shared/tree-kill.ts` 一处（原两条 site 各自指向本地副本，现各留一条并指向共享实现）。
  { file: 'src/shared/tree-kill.ts', marker: "spawnFn('taskkill'", end: '});', label: 'shared 收尸 taskkill（shell／MCP 共用同一处）' },
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

  // QD-R23 #1（PM 10:40 批复①）：**正向**断言 —— 计数相等只能说明"数量对"，
  // 不能说明"每一处都带了"。逐个 spawn( 调用块核，任何一处漏 windowsHide 立刻红。
  it('无遗漏：mcp-controller 里每一个 spawn( 调用块都带 windowsHide: true', () => {
    const src = read('src/host/mcp-controller.ts');
    const markers = [...src.matchAll(/\bspawn\(/g)].map((m) => m.index ?? 0);
    // 装置自检：确实扫到了 spawn 调用（否则下面的循环是在空跑）
    // 0.14.11：收尸 taskkill 上提到 src/shared/tree-kill.ts ⇒ 本文件剩 2 处（connectStdio／testConnection）。
    expect(markers.length).toBeGreaterThanOrEqual(2);
    let checked = 0;
    for (const idx of markers) {
      const block = src.slice(idx, src.indexOf('});', idx) + 3);
      expect(block, `第 ${idx} 字符处的 spawn( 调用块缺 windowsHide: true`).toContain('windowsHide: true');
      checked += 1;
    }
    expect(checked).toBe(markers.length);
  });
  it('清单完整性：host 运行时凡是引 child_process 的文件都在审计清单里，且 windowsHide 数与 spawn 数一致', () => {
    const expected: Record<string, number> = {
      // 0.14.11 tree-kill 单一来源化：shell 2→1（收尸 taskkill 搬走），mcp-controller 3→2（同），
      // 共享实现 src/shared/tree-kill.ts 新增 1。三个数之和不变（4 → 4），说明是「搬家」不是「减少」。
      'src/capabilities/shell.ts': 1,
      'src/capabilities/test-runner.ts': 1,
      'src/host/sandbox-executor.ts': 1,
      'src/host/automation.ts': 1,
      'src/host/mcp-controller.ts': 2,
      // 共享实现 2 处：① 注入点的类型签名 `TaskkillSpawn`（把三个属性写进类型，调用方漏掉就编译不过）
      // ② `killProcessTree` 里真正的 spawn 选项对象。两处都不是「实现副本」，是有意为之。
      'src/shared/tree-kill.ts': 2,
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
      // 0.14.11：与 taskkill 存在性那条**同一口径** —— 都用 codeOnly() 剥注释后再数。
      const hits = codeOnly(read(file)).match(/windowsHide:\s*true/g) ?? [];
      expect(hits.length, `${file} 的 windowsHide 数应为 ${count}`).toBe(count);
    }
  });

  // 0.14.11 tree-kill 单一来源化（PM 卡硬要求）：「两处都不再有本地副本」。
  // 只断「共享实现里有 taskkill」不够 —— 在任一处留一份本地 taskkill 副本，那种写法会
  // 悄悄复活「两份并行实现」的原缺陷，而上面的 windowsHide 计数可能仍然对得上。
  it('tree-kill 单一来源：shell.ts 与 mcp-controller.ts 都不得再自带 taskkill 实现', () => {
    const sharedSrc = read('src/shared/tree-kill.ts');
    // 装置自检：共享实现本体在场（否则下面的 not.toContain 是在空跑）
    expect(sharedSrc).toContain("spawnFn('taskkill'");
    for (const file of ['src/capabilities/shell.ts', 'src/host/mcp-controller.ts']) {
      const src = read(file);
      const code = codeOnly(src);
      expect(code, `${file} 仍自带 taskkill 实现（应改为引用 src/shared/tree-kill.ts）`).not.toContain('taskkill');
      expect(code, `${file} 必须引用共享实现`).toContain("from '../shared/tree-kill'");
    }
    // shell 侧调用面：原来的内联闭包必须改成对共享函数的一行委托
    expect(read('src/capabilities/shell.ts')).toMatch(/const killTree = \(\): void => killProcessTree\(child\);/);
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
