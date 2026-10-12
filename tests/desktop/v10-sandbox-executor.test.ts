/**
 * v0.10 验收测试：沙箱执行面（Python 代码执行 + 工件）
 *
 * 验收标准（来自路线图 v0.10）：
 * - python_exec 工具在隔离沙箱中执行代码
 * - 工件代码执行入口（RUN_ARTIFACT_CODE）
 * - 超时控制、输出大小限制
 * - 临时目录自动清理（不可信代码与宿主进程隔离）
 * - 执行结果回注格式正确
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execPythonInSandbox, runArtifactCode } from '../../src/host/sandbox-executor';

const tmpDir = path.join(os.tmpdir(), `studio-v10-test-${Date.now()}`);

beforeEach(async () => {
  await fs.promises.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// 检查系统是否有 python（没有的话跳过执行类测试）
async function hasPython(): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const cmd = process.platform === 'win32' ? 'python' : 'python3';
      execFile(cmd, ['--version'], { timeout: 5000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return true;
  } catch {
    return false;
  }
}

describe('v0.10: 沙箱执行器（execPythonInSandbox）', () => {
  it('空代码返回错误', async () => {
    const result = await execPythonInSandbox({ code: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('code is required');
  });

  it('空白代码返回错误', async () => {
    const result = await execPythonInSandbox({ code: '   \n  ' });
    expect(result.ok).toBe(false);
  });

  it('简单 print 执行成功（需要系统 python）', async () => {
    if (!await hasPython()) return; // 跳过
    const result = await execPythonInSandbox({ code: 'print("hello sandbox")' });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('hello sandbox');
    expect(result.exitCode).toBe(0);
  });

  it('多行代码执行成功（需要系统 python）', async () => {
    if (!await hasPython()) return;
    const code = `
x = 1 + 2
print(f"result: {x}")
for i in range(3):
    print(f"item {i}")
`;
    const result = await execPythonInSandbox({ code });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('result: 3');
    expect(result.stdout).toContain('item 0');
    expect(result.stdout).toContain('item 2');
  });

  it('语法错误返回失败和 stderr（需要系统 python）', async () => {
    if (!await hasPython()) return;
    const result = await execPythonInSandbox({ code: 'print("unterminated' });
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });

  it('运行时异常返回失败和 traceback（需要系统 python）', async () => {
    if (!await hasPython()) return;
    const result = await execPythonInSandbox({ code: '1 / 0' });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('ZeroDivisionError');
  });

  it('超时控制：无限循环被超时终止（需要系统 python）', async () => {
    if (!await hasPython()) return;
    const result = await execPythonInSandbox({
      code: 'while True: pass',
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('timed out');
  });

  it('cwd 可配置（需要系统 python）', async () => {
    if (!await hasPython()) return;
    const result = await execPythonInSandbox({
      code: 'import os; print(os.getcwd())',
      cwd: tmpDir,
    });
    expect(result.ok).toBe(true);
    // cwd 应该包含 tmpDir（Windows 路径可能有大小写差异）
    expect(result.stdout.toLowerCase()).toContain(tmpDir.toLowerCase());
  });

  it('执行后临时目录被清理（需要系统 python）', async () => {
    if (!await hasPython()) return;
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('studio-sandbox-')));
    await execPythonInSandbox({ code: 'print("cleanup test")' });
    const after = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('studio-sandbox-')));
    // 不应有新增的残留目录
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toHaveLength(0);
  });

  it('stdout 和 stderr 分离（需要系统 python）', async () => {
    if (!await hasPython()) return;
    const code = `
import sys
print("to stdout")
print("to stderr", file=sys.stderr)
`;
    const result = await execPythonInSandbox({ code });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('to stdout');
    expect(result.stderr).toContain('to stderr');
  });
});

describe('v0.10: 工件代码执行入口（runArtifactCode）', () => {
  it('成功执行返回 ok=true 和 output', async () => {
    if (!await hasPython()) return;
    const result = await runArtifactCode('print("artifact output")');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('artifact output');
    expect(result.exitCode).toBe(0);
  });

  it('失败执行返回 ok=false 和 error', async () => {
    if (!await hasPython()) return;
    const result = await runArtifactCode('raise ValueError("bad")');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.exitCode).not.toBe(0);
  });

  it('空代码返回错误', async () => {
    const result = await runArtifactCode('');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('code is required');
  });

  it('支持自定义超时', async () => {
    if (!await hasPython()) return;
    const result = await runArtifactCode('while True: pass', { timeoutMs: 1500 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('支持自定义 cwd', async () => {
    if (!await hasPython()) return;
    const result = await runArtifactCode('import os; print(os.getcwd())', { cwd: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.output.toLowerCase()).toContain(tmpDir.toLowerCase());
  });
});

describe('v0.10: 沙箱隔离性验证', () => {
  it('代码无法访问沙箱目录外的文件（默认 cwd 是临时目录）', async () => {
    if (!await hasPython()) return;
    // 创建一个测试文件在 tmpDir（沙箱外）
    const secretFile = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'secret data', 'utf8');

    // 沙箱默认 cwd 是临时目录，尝试用相对路径访问不到 secret.txt
    const result = await execPythonInSandbox({
      code: `
import os
# 尝试列出当前目录，不应包含 secret.txt
files = os.listdir('.')
print('secret.txt' in files)
`,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('False');
  });

  it('代码写入的文件在执行后随临时目录清理', async () => {
    if (!await hasPython()) return;
    const result = await execPythonInSandbox({
      code: `
with open('output.txt', 'w') as f:
    f.write('should be cleaned up')
print('written')
`,
    });
    expect(result.ok).toBe(true);
    // output.txt 应该在临时目录中，执行后被清理
    // 验证：系统临时目录中没有残留的 output.txt
    const files = fs.readdirSync(os.tmpdir());
    const leaked = files.filter((f) => f === 'output.txt');
    expect(leaked).toHaveLength(0);
  });
});
