// @vitest-environment node
/**
 * C1 P1 安全批 · TD-03：硬拒绝地板必须按「真正会执行的 argv」判定。
 *
 * ── 缺陷（审计 TD-03，PM 核实成立）──
 *
 * `checkHardDeny`（src/host/consent-router.ts）原来只读 `params.command` 字符串，
 * 且正则全部 `^` 锚定。而 `shell.exec`（src/capabilities/shell.ts）**优先使用
 * `params.argv`**，argv 形态还**不经过** `hasShellSyntax` 检查。于是：
 *
 *   { argv: ['diskpart'] }                    → 地板看到空 command → 放行
 *   { argv: ['cmd', '/c', 'shutdown', '/s'] } → 地板看到空 command → 放行
 *   { command: 'node -e "<任意代码>"' }       → 地板看到 node -e …，不命中任何名单 → 放行
 *
 * 承诺（「磁盘格式化/关机即便 full 档也直接拒绝」）与实现不一致。
 *
 * ── 本文件的断言口径 ──
 *
 * 1. **必须硬拒**：PM 的验收口径「`node -e <任意>` 被硬拒」，
 *    以及 argv 形态的 diskpart / shutdown / cmd /c 剥壳。
 * 2. **不得误伤**：普通命令（echo / ls / npm test / git status）必须**不**被硬拒 ——
 *    否则这条规则会把产品的主路径（提示词明确要求模型用 PowerShell）打死。
 * 3. **地板不可被绕过**：hard-deny 必须在档位判定**之前**生效（full 档也拒）。
 */

import { describe, it, expect } from 'vitest';
import { checkHardDeny, hardDenyFromArgv, hardDenyFromInlineText } from '../../src/host/consent-router';
import {
  inlineCodeOf,
  resolveArgvFromParams,
  stripCmdWrapper,
  tokenizeCommandString,
} from '../../src/shared/command-tokens';

describe('TD-03 · 命令取词（与执行侧同源）', () => {
  it('argv 形态优先于 command 形态（与 shell.ts execute 口径一致）', () => {
    expect(resolveArgvFromParams({ argv: ['node', '-e', 'x'], command: 'echo hi' })).toEqual(['node', '-e', 'x']);
    expect(resolveArgvFromParams({ command: 'npm run build' })).toEqual(['npm', 'run', 'build']);
    expect(resolveArgvFromParams({ cmd: 'git status' })).toEqual(['git', 'status']);
    expect(resolveArgvFromParams({})).toEqual([]);
    // 非字符串数组不算有效 argv → 回退 command
    expect(resolveArgvFromParams({ argv: [1, 2], command: 'echo hi' })).toEqual(['echo', 'hi']);
  });

  it('分词口径与 shell.ts 的 tokenizeCommand 逐字一致', async () => {
    const { tokenizeCommand } = await import('../../src/capabilities/shell');
    for (const cmd of [
      'npm run build',
      'node "C:/my dir/app.js" --flag',
      "echo 'a b c'",
      'git commit -m "a|b"',
      '',
    ]) {
      expect(tokenizeCommandString(cmd), `命令：${cmd}`).toEqual(tokenizeCommand(cmd));
    }
  });

  it('cmd /c 剥壳（递归剥多层）', () => {
    expect(stripCmdWrapper(['cmd', '/c', 'shutdown', '/s'])).toEqual(['shutdown', '/s']);
    expect(stripCmdWrapper(['cmd.exe', '/c', 'diskpart'])).toEqual(['diskpart']);
    expect(stripCmdWrapper(['cmd', '/c', 'cmd', '/c', 'shutdown', '/s'])).toEqual(['shutdown', '/s']);
    // 非 cmd 开头 → 原样
    expect(stripCmdWrapper(['node', '-e', 'x'])).toEqual(['node', '-e', 'x']);
    // cmd 但不是 /c /k（如 /? ）→ 不剥
    expect(stripCmdWrapper(['cmd', '/?', 'shutdown'])).toEqual(['cmd', '/?', 'shutdown']);
  });

  it('内联代码开关识别（node -e / python -c / powershell -Command）', () => {
    expect(inlineCodeOf(['node', '-e', 'console.log(1)'])).toBe('console.log(1)');
    expect(inlineCodeOf(['node', '--eval', 'console.log(1)'])).toBe('console.log(1)');
    expect(inlineCodeOf(['python', '-c', 'print(1)'])).toBe('print(1)');
    expect(inlineCodeOf(['powershell', '-Command', 'Get-ChildItem'])).toBe('Get-ChildItem');
    // 路径形态的 node 也要认
    expect(inlineCodeOf(['C:\\Program Files\\nodejs\\node.exe', '-e', 'x'])).toBe('x');
    // 非内联形态 → null
    expect(inlineCodeOf(['node', 'app.js'])).toBeNull();
    expect(inlineCodeOf(['echo', 'hi'])).toBeNull();
  });
});

describe('TD-03 · 硬拒绝地板 · argv 形态（PM 验收口径）', () => {
  it('PM 验收口径：node -e <任意> 被硬拒', () => {
    const rule = checkHardDeny('shell.exec', { command: 'node -e "console.log(1)"' }, null);
    expect(rule).toBe('inline-code');
  });

  it('node -e 用 argv 形态同样被硬拒', () => {
    const rule = checkHardDeny('shell.exec', { argv: ['node', '-e', 'require("child_process").execSync("shutdown /s")'] }, null);
    expect(rule).toBe('inline-code');
  });

  it('python -c 被硬拒', () => {
    expect(checkHardDeny('shell.exec', { argv: ['python', '-c', 'import os; os.remove("x")'] }, null)).toBe('inline-code');
  });

  it('argv:["diskpart"] 被硬拒（磁盘级破坏）', () => {
    expect(checkHardDeny('shell.exec', { argv: ['diskpart'] }, null)).toBe('dangerous-disk');
  });

  it('argv:["shutdown","/s","/t","0"] 被硬拒（电源控制）', () => {
    expect(checkHardDeny('shell.exec', { argv: ['shutdown', '/s', '/t', '0'] }, null)).toBe('power-control');
  });

  it('cmd /c 藏起来的 shutdown 被硬拒（剥壳后判定）', () => {
    expect(checkHardDeny('shell.exec', { argv: ['cmd', '/c', 'shutdown', '/s'] }, null)).toBe('power-control');
    expect(checkHardDeny('shell.exec', { command: 'cmd /c shutdown /s' }, null)).toBe('power-control');
  });

  it('command 形态的 format / shutdown 仍然被硬拒（既有口径不回归）', () => {
    expect(checkHardDeny('shell.exec', { command: 'format C:' }, null)).toBe('dangerous-disk');
    expect(checkHardDeny('shell.exec', { command: 'shutdown /s' }, null)).toBe('power-control');
  });

  it('盘根递归删除被硬拒（目标确实指向盘根）', () => {
    expect(checkHardDeny('shell.exec', { argv: ['rm', '-rf', 'C:\\'] }, null)).toBe('recursive-root-delete');
    expect(checkHardDeny('shell.exec', { argv: ['rm', '-rf', '/'] }, null)).toBe('recursive-root-delete');
  });

  it('路径形态的可执行文件也能命中（不再 ^ 锚定整串）', () => {
    expect(checkHardDeny('shell.exec', { argv: ['C:\\Windows\\System32\\diskpart.exe'] }, null)).toBe('dangerous-disk');
  });

  it('mcp.test / mcp.save 的嵌套 config.command 走同一套判定（磁盘/电源）', () => {
    expect(
      checkHardDeny('mcp.test', { config: { command: 'diskpart' } }, null),
    ).toBe('dangerous-disk');
    expect(
      checkHardDeny('mcp.save', { config: { command: 'shutdown', args: ['/s'] } }, null),
    ).toBe('power-control');
  });

  it('mcp.test / mcp.save 允许 node -e 形态（MCP server 的合法启动方式）', () => {
    // 审计 R2-04 的假服务器场景就是 `node -e "setInterval(...)"`：
    // mcp.* 的启动命令由用户在 UI 里自己填，且这两个工具不在模型的工具表里
    // （tool-contract 的 UI_ONLY_TOOLS）→ 模型够不着 → 不该被「内联代码」一刀切打死。
    expect(
      checkHardDeny('mcp.test', { config: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] } }, null),
    ).toBeNull();
  });

  it('但 mcp.test 的 node -e 载荷里藏危险命令仍被硬拒', () => {
    expect(
      checkHardDeny('mcp.test', { config: { command: 'node', args: ['-e', 'require("child_process").execSync("shutdown /s")'] } }, null),
    ).toBe('power-control');
  });
});

describe('TD-03 · 不得误伤（产品主路径必须仍可用）', () => {
  it('普通命令不被硬拒', () => {
    for (const cmd of [
      'echo hi',
      'ls -la',
      'npm run build',
      'git status',
      'npx vitest run tests/desktop',
      'python --version',
      'node app.js',
    ]) {
      expect(checkHardDeny('shell.exec', { command: cmd }, null), `命令：${cmd}`).toBeNull();
    }
  });

  it('argv 形态的普通命令也不被硬拒', () => {
    expect(checkHardDeny('shell.exec', { argv: ['npm', 'run', 'build'] }, null)).toBeNull();
    expect(checkHardDeny('shell.exec', { argv: ['git', 'status'] }, null)).toBeNull();
  });

  it('powershell -Command <普通载荷> 不被硬拒（提示词要求模型优先用 PowerShell）', () => {
    expect(
      checkHardDeny('shell.exec', { argv: ['powershell', '-NoProfile', '-Command', 'Get-ChildItem E:/x'] }, null),
    ).toBeNull();
  });

  it('powershell -Command <危险载荷> 被硬拒（展开载荷判定）', () => {
    expect(
      checkHardDeny('shell.exec', { argv: ['powershell', '-Command', 'shutdown /s'] }, null),
    ).toBe('power-control');
    expect(
      checkHardDeny('shell.exec', { argv: ['powershell', '-Command', 'format C:'] }, null),
    ).toBe('dangerous-disk');
  });

  it('powershell -EncodedCommand 被硬拒（base64 载荷不可读，无法判定）', () => {
    expect(
      checkHardDeny('shell.exec', { argv: ['powershell', '-EncodedCommand', 'AAAA' ] }, null),
    ).toBe('inline-code');
  });

  it('普通 rm -rf（不是盘根）不被硬拒 —— 它走 policy.ts 的风险审批闸', () => {
    expect(checkHardDeny('shell.exec', { argv: ['rm', '-rf', './build'] }, null)).toBeNull();
  });

  it('敏感路径判定不回归', () => {
    expect(checkHardDeny('file.write', { path: '/etc/passwd' }, '/etc/passwd')).toBe('sensitive-path');
  });
});

describe('TD-03 · 内联载荷文本兜底扫描', () => {
  it('载荷里藏危险命令名即硬拒', () => {
    expect(hardDenyFromInlineText('require("child_process").execSync("shutdown /s")')).toBe('power-control');
    expect(hardDenyFromInlineText('Run("format C:")')).toBe('dangerous-disk');
  });

  it('普通载荷不误伤', () => {
    expect(hardDenyFromInlineText('console.log("hello")')).toBeNull();
    expect(hardDenyFromInlineText('Get-ChildItem E:/x')).toBeNull();
  });
});

describe('TD-03 · 硬拒地板不可被绕过', () => {
  it('宿主真实调用：full 档下 argv:["diskpart"] 被拒，且审计 hardRule 非空', async () => {
    // 审计 TD-03 的验收判据原文：
    // 「full 档下上述三种调用均返回 {ok:false, reason:'hard-deny'} 且审计 hardRule 非空」
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createDesktopHost } = await import('../../src/host/desktop-host');

    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td03-host-'));
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      policyMode: 'full',
    });
    await host.start();
    try {
      for (const [argv, expectedRule] of [
        [['diskpart'], 'dangerous-disk'],
        [['shutdown', '/s', '/t', '0'], 'power-control'],
        [['cmd', '/c', 'shutdown', '/s'], 'power-control'],
      ] as Array<[string[], string]>) {
        const r = await host.invokeTool('shell.exec', { argv });
        expect(r.ok, `argv=${JSON.stringify(argv)} 应被拒`).toBe(false);
        expect(r.reason, `argv=${JSON.stringify(argv)} 的 reason`).toBe('hard-deny');
        const rec = host.audit.list().filter((x) => x.tool === 'shell.exec').at(-1);
        expect(rec?.outcome).toBe('policy-denied');
        expect(rec?.reason).toBe('hard-deny');
        expect(rec?.hardRule, `argv=${JSON.stringify(argv)} 的审计 hardRule 非空`).toBe(expectedRule);
      }
    } finally {
      await host.stop();
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it('宿主真实调用：argv:["echo","hi"] 仍正常执行（不误伤）', async () => {
    const { createDesktopHost } = await import('../../src/host/desktop-host');
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      policyMode: 'full',
    });
    await host.start();
    try {
      const r = await host.invokeTool('shell.exec', { argv: ['echo', 'hi'] });
      expect(r.ok).toBe(true);
      expect(String((r.data as { stdout: string }).stdout)).toContain('hi');
    } finally {
      await host.stop();
    }
  });

  it('full 档（策略放行）下硬拒仍然生效', async () => {
    const { evaluatePolicy } = await import('../../src/host/policy');
    const { resolveAuthorization } = await import('../../src/host/authorization');
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'shell.exec')!;

    const params = { argv: ['shutdown', '/s'] };
    const verdict = evaluatePolicy({
      tool: 'shell.exec',
      params,
      mode: 'full',
      workspace: null,
    });
    // 策略层在 full 档确实放行（否则这条测试就不成立）
    expect(verdict.decision).toBe('allow');

    const hardRule = checkHardDeny('shell.exec', params, null);
    const r = resolveAuthorization({
      tool: 'shell.exec',
      def,
      params,
      mode: 'full',
      policyVerdict: verdict,
      hardRule,
      workspaceHash: 'ws',
      principal: 'main',
      now: 0,
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('hard-deny');
    expect(r.hardRule).toBe('power-control');
  });

  it('对话级放行也不能覆盖 hard-deny', async () => {
    const { resolveAuthorization } = await import('../../src/host/authorization');
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'shell.exec')!;
    const r = resolveAuthorization({
      tool: 'shell.exec',
      def,
      params: { argv: ['diskpart'] },
      mode: 'full',
      policyVerdict: { decision: 'allow', reason: 'inside-workspace' },
      hardRule: 'dangerous-disk',
      conversationApproved: true,
      workspaceHash: 'ws',
      principal: 'main',
      now: 0,
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('hard-deny');
  });
});

describe('TD-03 · hardDenyFromArgv 单元口径', () => {
  it('空 argv → null', () => {
    expect(hardDenyFromArgv([])).toBeNull();
  });

  it('mkfs / mkfs.ext4 也算磁盘级破坏', () => {
    expect(hardDenyFromArgv(['mkfs.ext4', '/dev/sda1'])).toBe('dangerous-disk');
  });

  it('dd if= 算磁盘级破坏', () => {
    expect(hardDenyFromArgv(['dd', 'if=/dev/zero', 'of=/dev/sda'])).toBe('dangerous-disk');
  });

  it('Stop-Computer / Restart-Computer 算电源控制', () => {
    expect(hardDenyFromArgv(['Stop-Computer'])).toBe('power-control');
    expect(hardDenyFromArgv(['Restart-Computer', '-Force'])).toBe('power-control');
  });
});
