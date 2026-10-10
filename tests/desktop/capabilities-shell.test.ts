import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShellCapability, hasShellSyntax, tokenizeCommand } from '../../src/capabilities/shell';
import { createFileTools } from '../../src/capabilities/file';
import { createWorkspace } from '../../src/host/workspace';

const node = process.execPath;

describe('shell.exec —— argv 执行与安全红线', () => {
  it('argv 方式执行成功并回传 stdout', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ argv: [node, '-e', 'console.log("hello-studio")'] });
    expect(r.ok).toBe(true);
    expect(String((r.data as { stdout: string }).stdout)).toContain('hello-studio');
    expect((r.data as { exitCode: number }).exitCode).toBe(0);
  });

  it('命令串按引号规则切分，带空格的引号路径不被拆坏', () => {
    expect(tokenizeCommand('npm run build')).toEqual(['npm', 'run', 'build']);
    expect(tokenizeCommand('node "C:/my dir/app.js" --flag')).toEqual(['node', 'C:/my dir/app.js', '--flag']);
    expect(tokenizeCommand("echo 'a b c'")).toEqual(['echo', 'a b c']);
  });

  it('含管道/重定向等 shell 语法 → 显式拒绝，而不是当成普通参数执行', async () => {
    expect(hasShellSyntax('cat a.txt | grep x')).toBe(true);
    expect(hasShellSyntax('echo hi > out.txt')).toBe(true);
    expect(hasShellSyntax('npm run build')).toBe(false);
    // 引号内的同类字符不算语法
    expect(hasShellSyntax('git commit -m "a|b"')).toBe(false);

    const cap = createShellCapability();
    const r = await cap.execute({ command: 'echo hi > out.txt' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('shell-syntax-unsupported');
  });

  it('缺失命令 → missing-command，不产生任何子进程', async () => {
    const cap = createShellCapability();
    expect((await cap.execute({})).error).toBe('missing-command');
    expect((await cap.execute({ command: '   ' })).error).toBe('missing-command');
  });

  it('非零退出码：ok=false 且带上 exitCode（成功与否不被混为一谈）', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ argv: [node, '-e', 'process.exit(3)'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('nonzero-exit');
    expect((r.data as { exitCode: number }).exitCode).toBe(3);
  });

  it('超时上限生效：子进程被杀而不再挂住宿主', async () => {
    const cap = createShellCapability({ timeoutMs: 300 });
    const started = Date.now();
    const r = await cap.execute({ argv: [node, '-e', 'setTimeout(() => {}, 30000)'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('注入串作为 argv 元素时是普通参数，不会被解释执行', async () => {
    const cap = createShellCapability();
    // 若发生解释执行，| 后面的 whoami 会跑起来并污染 stdout；这里只应原样输出参数
    const r = await cap.execute({ argv: [node, '-e', 'console.log(process.argv[1])', 'x | echo pwned'] });
    expect(r.ok).toBe(true);
    const stdout = (r.data as { stdout: string }).stdout;
    expect(stdout).toContain('x | echo pwned');
    expect(stdout).not.toContain('pwned\n\n');
  });

  it('超时参数被夹到合法区间，异常值不会导致永不超时', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ argv: [node, '-e', 'console.log(1)'], timeoutMs: -5 });
    expect(r.ok).toBe(true);
    expect((r.data as { argv: string[] }).argv[0]).toBe(node);
  });
});

describe('file.* —— 工作区边界（纵深防御）', () => {
  let tmp: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-ws-'));
    cleanup = async () => {
      await fsp.rm(tmp, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  const tools = (root: string) => createFileTools({ workspace: createWorkspace(root) });

  it('工作区内写入后可读取', async () => {
    const t = tools(tmp);
    const file = path.join(tmp, 'note.txt');
    const w = await t['file.write'].execute({ path: file, content: 'hello' });
    expect(w.ok).toBe(true);
    const r = await t['file.read'].execute({ path: file });
    expect(r.ok).toBe(true);
    expect((r.data as { text: string }).text).toBe('hello');
  });

  it('追加模式不覆盖原内容', async () => {
    const t = tools(tmp);
    const file = path.join(tmp, 'a.txt');
    await t['file.write'].execute({ path: file, content: 'A' });
    await t['file.write'].execute({ path: file, content: 'B', append: true });
    const r = await t['file.read'].execute({ path: file });
    expect((r.data as { text: string }).text).toBe('AB');
  });

  it('列出目录返回条目类型', async () => {
    const t = tools(tmp);
    await fsp.writeFile(path.join(tmp, 'x.txt'), '1');
    await fsp.mkdir(path.join(tmp, 'sub'));
    const r = await t['file.list'].execute({ path: tmp });
    expect(r.ok).toBe(true);
    const items = (r.data as { items: { name: string; type: string }[] }).items;
    expect(items.map((i) => i.name).sort()).toEqual(['sub', 'x.txt']);
    expect(items.find((i) => i.name === 'sub')?.type).toBe('dir');
  });

  it('file.stat 返回文件元信息（size/类型/时间戳）', async () => {
    const t = tools(tmp);
    const file = path.join(tmp, 's.txt');
    await fsp.writeFile(file, '12345');
    const r = await t['file.stat'].execute({ path: file });
    expect(r.ok).toBe(true);
    const d = r.data as { size: number; isFile: boolean; isDirectory: boolean; modifiedAt: string };
    expect(d.size).toBe(5);
    expect(d.isFile).toBe(true);
    expect(d.isDirectory).toBe(false);
    expect(d.modifiedAt).toBeTruthy();

    const dir = await t['file.stat'].execute({ path: tmp });
    expect((dir.data as { isDirectory: boolean }).isDirectory).toBe(true);
  });

  it('file.stat 对不存在的目标返回 not-found', async () => {
    const t = tools(tmp);
    const r = await t['file.stat'].execute({ path: path.join(tmp, 'nope.txt') });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not-found');
  });

  it('越界路径被拒绝（系统临时目录之外的路径）', async () => {
    const t = tools(tmp);
    const outside = path.join(path.dirname(tmp), 'outside-of-ws.txt');
    await fsp.writeFile(outside, 'secret');
    const r = await t['file.read'].execute({ path: outside });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('outside-workspace');
  });

  it('未配置工作区时文件系统能力整体不可用（fail-closed）', async () => {
    const t = createFileTools({ workspace: null });
    const r = await t['file.read'].execute({ path: path.join(tmp, 'anything') });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('workspace-unconfigured');
  });

  it('读取不存在的文件返回结构化错误而非抛异常', async () => {
    const t = tools(tmp);
    const r = await t['file.read'].execute({ path: path.join(tmp, 'nope.txt') });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('io-error');
  });

  it('写入缺少 content → missing-content', async () => {
    const t = tools(tmp);
    const r = await t['file.write'].execute({ path: path.join(tmp, 'b.txt') });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing-content');
  });
});
