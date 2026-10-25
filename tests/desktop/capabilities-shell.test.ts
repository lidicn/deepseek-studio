import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShellCapability, hasShellSyntax, resolveWindowsScript, tokenizeCommand, windowsEnoentHint } from '../../src/capabilities/shell';
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
    // v1.8：单引号不再是引号（shell:false 下），是普通字符
    expect(tokenizeCommand("echo 'a b c'")).toEqual(['echo', "'a", 'b', "c'"]);
  });

  it('含管道/重定向等 shell 语法 → 显式拒绝，而不是当成普通参数执行', async () => {
    expect(hasShellSyntax('cat a.txt | grep x')).toBe(true);
    expect(hasShellSyntax('echo hi > out.txt')).toBe(true);
    expect(hasShellSyntax('npm run build')).toBe(false);
    // 双引号内的同类字符不算语法
    expect(hasShellSyntax('git commit -m "a|b"')).toBe(false);

    const cap = createShellCapability();
    const r = await cap.execute({ command: 'echo hi > out.txt' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('shell-syntax-unsupported');
  });

  // v1.8：命令注入回归测试。单引号不再是引号，'&|<> 被检测为 shell 语法并拒绝。
  // 之前单引号被当引号 → hasShellSyntax 跳过检查 → tokenizeCommand 剥离引号 →
  // 裸元字符进 argv → Windows cmd /c 二次解释 → 命令注入。
  it('单引号内的元字符被检测为 shell 语法（命令注入修复）', () => {
    expect(hasShellSyntax("echo 'x&calc'")).toBe(true);
    expect(hasShellSyntax("echo 'x|more'")).toBe(true);
    expect(hasShellSyntax("echo 'x>out.txt'")).toBe(true);
    expect(hasShellSyntax("echo 'x;whoami'")).toBe(true);

    // 这些命令现在应被拒绝（而非注入）
    const cap = createShellCapability();
    const r1 = cap.execute({ command: "echo 'x&calc'" });
    void r1;
  });

  it('单引号包裹的元字符命令被 shell-syntax-unsupported 拒绝', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ command: "echo 'x&calc'" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('shell-syntax-unsupported');
  });

  // v1.9：双引号内元字符命令注入修复（审计补丁）。
  // 漏洞链：echo "x&calc" → hasShellSyntax 判安全（双引号内跳过 &）→
  // tokenizeCommand 剥离双引号 → argv=['echo','x&calc'] → cmd /c echo x&calc →
  // cmd 二次解释 & → 先 echo x 再执行 calc → 命令注入成立。
  // v1.8 只堵了单引号路径（单引号在 shell:false 下不是引号），双引号路径漏了。
  // CMD_BUILTINS 与 cmd /c 只存在于 Windows；POSIX 的 echo 是外部程序，
  // shell:false 下引号内元字符只是普通 argv，不能把 Windows 安全用例套到 POSIX。
  const cmdBuiltinIt = process.platform === 'win32' ? it : it.skip;
  cmdBuiltinIt('双引号包裹的元字符在内建命令中被拒绝（命令注入修复）', async () => {
    const cap = createShellCapability();
    // echo 是 CMD_BUILTINS，走 cmd /c 路径，双引号内 & 会被 cmd 二次解释
    const r1 = await cap.execute({ command: 'echo "hello & whoami"' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe('shell-metachar-in-cmd-builtin');

    const r2 = await cap.execute({ command: 'dir "C:/x & calc"' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('shell-metachar-in-cmd-builtin');

    // 管道符
    const r3 = await cap.execute({ command: 'echo "a|b"' });
    expect(r3.ok).toBe(false);
    expect(r3.error).toBe('shell-metachar-in-cmd-builtin');

    // 重定向符
    const r4 = await cap.execute({ command: 'echo "a>out.txt"' });
    expect(r4.ok).toBe(false);
    expect(r4.error).toBe('shell-metachar-in-cmd-builtin');
  });

  // v1.9：无元字符的双引号内建命令正常执行（不误杀合法用例）
  it('双引号内建命令无元字符时正常执行', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ command: 'echo "hello world"' });
    expect(r.ok).toBe(true);
    expect((r.data as { stdout: string }).stdout).toContain('hello world');
  });

  // v1.9：非内建命令（如 git）双引号参数含 | 不被拒绝（git 不走 cmd /c）
  it('非内建命令双引号内元字符不被误杀', () => {
    // git commit -m "a|b" 的 | 在双引号内，hasShellSyntax 返回 false，
    // git 不在 CMD_BUILTINS，不走 cmd /c，shell:false 下 argv 元素含 | 不被解释
    expect(hasShellSyntax('git commit -m "a|b"')).toBe(false);
    expect(hasShellSyntax('node -e "console.log(1|2)"')).toBe(false);
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

  it('超时上限生效：子进程被杀而不再挂住宿主（R1-03/R1-08：timedOut:true、exitCode:null）', async () => {
    const cap = createShellCapability({ timeoutMs: 300 });
    const started = Date.now();
    const r = await cap.execute({ argv: [node, '-e', 'setTimeout(() => {}, 30000)'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
    // R1-08：超时结果显式 timedOut:true、exitCode:null，与「非零退出」用不同字段区分
    const data = r.data as { timedOut?: boolean; exitCode: number | null; timeoutMs?: number };
    expect(data.timedOut).toBe(true);
    expect(data.exitCode).toBeNull();
    expect(data.timeoutMs).toBe(300);
    // R1-03：超时即 resolve，不再依赖裸 kill 的 close；details 同样带 timedOut
    expect((r.details as { timedOut?: boolean })?.timedOut).toBe(true);
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

describe('D-1 Windows .cmd/.bat 路由', () => {
  const winIt = process.platform === 'win32' ? it : it.skip;
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-d1-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  async function writeFixtureCmd(name: string, body: string): Promise<string> {
    const p = path.join(tmp, name);
    await fsp.writeFile(p, body.replace(/\n/g, '\r\n'), 'utf8');
    return p;
  }

  winIt('fixture .cmd 正控：经 cmd /c 执行并回传 stdout（不依赖开发机是否装了 npx）', async () => {
    const cap = createShellCapability();
    const cmdPath = await writeFixtureCmd('hello.cmd', '@echo off\necho studio-cmd-ok %1');
    const r = await cap.execute({ argv: [cmdPath, 'alpha'] });
    expect(r.ok).toBe(true);
    expect((r.data as { stdout: string }).stdout).toContain('studio-cmd-ok alpha');
  });

  winIt('.exe 负控：node 不被加 cmd /c，argv[0] 保持原可执行、输出是版本号', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ argv: [node, '--version'] });
    expect(r.ok).toBe(true);
    const data = r.data as { argv: string[]; stdout: string };
    expect(data.argv[0]).toBe(node); // 未被改写成 cmd
    expect(data.argv[0]).not.toBe('cmd');
    expect(data.stdout.trim().startsWith('v')).toBe(true);
  });

  winIt('.cmd 参数含 & 被拒绝（cmd 二次解释注入面）', async () => {
    const cap = createShellCapability();
    const cmdPath = await writeFixtureCmd('bad.cmd', '@echo off\necho %1');
    const r = await cap.execute({ argv: [cmdPath, 'a & whoami'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('shell-metachar-in-cmd-builtin');
  });

  winIt('不存在的命令返回 spawn-failed', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ argv: ['definitely-not-a-real-exe-xyz-99999'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('spawn-failed');
  });

  it('resolveWindowsScript：.cmd 绝对路径命中返回路径、.exe 文件返回 null、不存在返回 null', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-d1-unit-'));
    try {
      const cmdPath = path.join(dir, 'probe.cmd');
      await fsp.writeFile(cmdPath, '@echo off\r\necho hi\r\n', 'utf8');
      expect(resolveWindowsScript(cmdPath)).toBe(cmdPath);

      const exePath = path.join(dir, 'probe.exe');
      await fsp.writeFile(exePath, 'fake-bytes', 'utf8');
      expect(resolveWindowsScript(exePath)).toBeNull();

      expect(resolveWindowsScript(path.join(dir, 'nope.cmd'))).toBeNull();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('resolveWindowsScript：argv0 显式带 .cmd 时直接命中原路径，不重复追加扩展名', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-d1-explicit-'));
    try {
      const cmdPath = path.join(dir, 'tool.cmd');
      await fsp.writeFile(cmdPath, '@echo off\r\necho hi\r\n', 'utf8');
      // 显式 .cmd：原样返回，不会再去找 tool.cmd.CMD / tool.cmd.EXE
      expect(resolveWindowsScript(cmdPath)).toBe(cmdPath);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  winIt('真实 PATH 影子：临时目录同时放无扩展名 probe 和 probe.cmd，probe 必须命中 .cmd 并经 cmd /c 执行', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-d1-shadow-'));
    try {
      await fsp.writeFile(path.join(dir, 'probe'), 'fake-no-ext', 'utf8');
      await fsp.writeFile(path.join(dir, 'probe.cmd'), '@echo off\r\necho probe-shadow-ok %1\r\n', 'utf8');

      const savedPath = process.env.PATH;
      const savedPathext = process.env.PATHEXT;
      process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
      process.env.PATHEXT = '.EXE;.CMD';
      try {
        const expectedCmd = path.join(dir, 'probe.cmd');
        // 1) 纯解析：无扩展名 probe 不能终止搜索，必须落到 probe.cmd
        //    （PATHEXT 候选可能为大写 .CMD，Windows 大小写不敏感，按小写比较）
        expect((resolveWindowsScript('probe') ?? '').toLowerCase()).toBe(expectedCmd.toLowerCase());

        // 2) 端到端：cap.execute 实际经 cmd /c 跑通
        const cap = createShellCapability();
        const r = await cap.execute({ argv: ['probe', 'beta'] });
        expect(r.ok).toBe(true);
        expect((r.data as { stdout: string }).stdout).toContain('probe-shadow-ok beta');
        const usedArgv = (r.data as { argv: string[] }).argv;
        expect(usedArgv[0]).toBe('cmd');
        expect(usedArgv[1]).toBe('/c');
        expect(usedArgv[2].toLowerCase()).toBe(expectedCmd.toLowerCase());
      } finally {
        process.env.PATH = savedPath;
        process.env.PATHEXT = savedPathext;
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
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

describe('D-2 Windows ENOENT 可操作 hint', () => {
  const winIt = process.platform === 'win32' ? it : it.skip;

  winIt('不存在命令 → spawn-failed 且 data.hint 提示改用 powershell -Command', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ argv: ['definitely-not-a-real-exe-xyz-99999'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('spawn-failed');
    const data = r.data as { hint?: string; message?: string };
    expect(typeof data.hint).toBe('string');
    expect(data.hint).toContain('powershell -Command');
    // hint 不泄露 PATH / 环境变量 / 系统路径清单
    expect(data.hint).not.toMatch(/PATH|C:\\Windows|System32/i);
  });

  winIt('非零退出 → spawn 成功，不带 ENOENT hint', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ argv: [node, '-e', 'process.exit(3)'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('nonzero-exit');
    expect((r.data as { hint?: string }).hint).toBeUndefined();
  });

  winIt('超时 → 不带 ENOENT hint', async () => {
    const cap = createShellCapability({ timeoutMs: 300 });
    const r = await cap.execute({ argv: [node, '-e', 'setTimeout(() => {}, 30000)'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
    expect((r.data as { hint?: string }).hint).toBeUndefined();
  });

  it('正常命令仍成功', async () => {
    const cap = createShellCapability();
    const r = await cap.execute({ argv: [node, '-e', 'console.log("d2-ok")'] });
    expect(r.ok).toBe(true);
    expect((r.data as { stdout: string }).stdout).toContain('d2-ok');
  });

  it('windowsEnoentHint：仅 ENOENT 才给出 hint，其他错误码为 undefined', () => {
    const enoent = new Error('spawn failed') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    const hint = windowsEnoentHint(enoent);
    if (process.platform === 'win32') {
      expect(hint).toBeDefined();
      expect(hint).toContain('powershell -Command');
    } else {
      expect(hint).toBeUndefined();
    }
    const eacces = new Error('denied') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    expect(windowsEnoentHint(eacces)).toBeUndefined();
    expect(windowsEnoentHint(new Error('plain'))).toBeUndefined();
  });
});
