/**
 * C1 P1-1 回归测试：shell 安全边界（命令注入 + 参数丢失）。
 *
 * 契约（对应 BUG-009 / BUG-008）：
 *   1. **显式 `cmd /c` 的元字符检查** —— `argv: ['cmd','/c','echo','x&calc']` 必须被拒；
 *      原来只有「自动加 cmd /c 前缀」的两条路径做检查，用户自己拼的 cmd /c **一个都不查**
 *      → cmd 二次解释 → 命令注入。
 *   2. **`-EncodedCommand` 转换保留尾部参数** —— `powershell -Command <script> -NoProfile`
 *      转换后 `-NoProfile` 不能丢；原来 `argv.slice(0, cmdIdx)` 把之后的参数全切了。
 *
 * 全部用 `argv` 数组调用（不经命令串），**不真起 cmd**，秒级完成。
 */
import { describe, it, expect } from 'vitest';
import { createShellCapability } from '../../src/capabilities/shell';

const isWin = process.platform === 'win32';

describe('C1 P1-1 / BUG-009 + BUG-008：shell 安全边界', () => {
  it('1. 显式 cmd /c 的参数含 cmd 元字符 → 拒绝（命令注入）', async () => {
    if (!isWin) return; // 仅 Windows 有 cmd 二次解释
    const cap = createShellCapability();
    const r = await cap.execute({ argv: ['cmd', '/c', 'echo', 'x&calc'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('shell-metachar-in-cmd-builtin');
  });

  it('2. 显式 cmd /c 的各个元字符都要拦（| < > ^）', async () => {
    if (!isWin) return;
    const cap = createShellCapability();
    for (const meta of ['x|y', 'x<y', 'x>y', 'x^y']) {
      const r = await cap.execute({ argv: ['cmd', '/c', 'echo', meta] });
      expect(r.ok, `元字符 ${meta} 应被拒`).toBe(false);
      expect(r.error).toBe('shell-metachar-in-cmd-builtin');
    }
  });

  it('3. cmd.exe 变体同样被拦', async () => {
    if (!isWin) return;
    const cap = createShellCapability();
    const r = await cap.execute({ argv: ['cmd.exe', '/c', 'echo', 'x&calc'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('shell-metachar-in-cmd-builtin');
  });

  it('4. cmd /c 的大小写 /C 变体同样被拦', async () => {
    if (!isWin) return;
    const cap = createShellCapability();
    const r = await cap.execute({ argv: ['cmd', '/C', 'echo', 'x&calc'] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('shell-metachar-in-cmd-builtin');
  });

  it('5. 不含元字符的 cmd /c 正常放行（不误伤）', async () => {
    if (!isWin) return;
    const cap = createShellCapability();
    const r = await cap.execute({ argv: ['cmd', '/c', 'echo', 'hello'] });
    // 允许放行（能执行成功或因环境失败都行），关键是**不被元字符检查拦下**。
    expect(r.error).not.toBe('shell-metachar-in-cmd-builtin');
  });

  it('6. 非 cmd 命令不受此检查影响（不误伤普通命令）', async () => {
    const cap = createShellCapability();
    const node = process.execPath;
    const r = await cap.execute({ argv: [node, '-e', 'console.log("p1-1-ok")'] });
    expect(r.ok).toBe(true);
    expect(String((r.data as { stdout: string }).stdout)).toContain('p1-1-ok');
  });
});

describe('C1 P1-1 / BUG-008：-EncodedCommand 转换保留尾部参数', () => {
  it('7. powershell -Command <script> -TailMarker：尾部参数不丢', async () => {
    if (!isWin) return;
    const cap = createShellCapability();
    // PowerShell 把 `-Command` 的尾部参数传给脚本 `$args` 的标准写法是 `& { script }` 包装
    // （实测：`-Command 'script' AAA` 里 AAA 不会进 $args；`& { script }` 才会）。
    const r = await cap.execute({
      argv: [
        'powershell',
        '-NoProfile',
        '-Command',
        '& { Write-Output ("tail=" + $args[0]) }',
        '-TailMarker',
      ],
    });
    expect(r.ok).toBe(true);
    const stdout = String((r.data as { stdout: string }).stdout ?? '');
    expect(stdout).toContain('tail=-TailMarker');
  });

  it('8. -Command 之后的多个参数顺序不变', async () => {
    if (!isWin) return;
    const cap = createShellCapability();
    const r = await cap.execute({
      argv: [
        'powershell',
        '-NoProfile',
        '-Command',
        '& { Write-Output ("a=" + $args[0] + "," + $args[1]) }',
        'AAA',
        'BBB',
      ],
    });
    expect(r.ok).toBe(true);
    const stdout = String((r.data as { stdout: string }).stdout ?? '');
    expect(stdout).toContain('a=AAA,BBB');
  });

  it('9. 没有尾部参数时仍走 -EncodedCommand（中文编码修复的原始目标场景）', async () => {
    if (!isWin) return;
    const cap = createShellCapability();
    // 无尾部参数 → 转 -EncodedCommand（PowerShell 接受，退出码 0）。
    const r = await cap.execute({
      argv: ['powershell', '-NoProfile', '-Command', 'Write-Output "enc-ok"'],
    });
    expect(r.ok).toBe(true);
    expect(String((r.data as { stdout: string }).stdout ?? '')).toContain('enc-ok');
  });
});
