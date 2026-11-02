/**
 * command-tokens.ts — 命令串 / argv 的统一取词（纯函数，零依赖）
 *
 * ── 为什么要有这个模块 ──
 *
 * C1 P1 安全批 TD-03：`checkHardDeny`（src/host/consent-router.ts）只读
 * `params.command` 字符串，而 `shell.exec`（src/capabilities/shell.ts）
 * **优先使用 `params.argv`**，且 `argv` 形态**不经过** `hasShellSyntax` 检查。
 *
 * 于是：
 *   `{ command: 'node', args: ['-e', '<任意>'] }`  → 硬拒地板只看 `command`，
 *   看到的是 `node`（不在任何硬拒名单里）→ **直接穿过地板**；
 *   `{ argv: ['diskpart'] }` → 硬拒地板看到 `params.command` 为空 → **同样穿过**。
 *
 * 修法的前提是「硬拒地板看到的 argv，必须与执行侧真正会跑的 argv 一致」。
 * 这要求**同源取词**：这里实现一份纯函数，执行侧（shell.ts）与判定侧
 * （consent-router.ts）都调用它，两边看到的东西永远相同。
 *
 * ── 分层纪律 ──
 *
 * 本模块放在 `src/shared/`：
 *   - `src/capabilities/shell.ts`（执行侧，Node 侧）可以 import 它；
 *   - `src/host/consent-router.ts`（判定侧，Node 侧）可以 import 它；
 *   - `src/inject/**` 不需要它 → 注入侧产物（entry.js）体积与依赖面**不受影响**。
 *
 * 本模块**不碰 fs / child_process / process.env**，纯字符串处理，可被单测穷举。
 */

/**
 * 按引号规则切分命令串为 token。
 *
 * 口径与既有 `capabilities/shell.ts` 的 `tokenizeCommand` **逐字一致**
 * （v1.8 安全修复：只认双引号 " 为引号，单引号 ' 是普通字符——
 *  shell:false 下 Windows cmd 也不认单引号，把它当引号会导致裸元字符进入 argv）。
 *
 * 保留在此而非直接复用 shell.ts 的原因：shell.ts 会 import node:child_process /
 * node:fs，判定侧不该为此拖进这些依赖（且 inject 产物不打包 host 侧）。
 */
export function tokenizeCommandString(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inQuote = false;

  for (const ch of command) {
    if (inQuote) {
      if (ch === '"') inQuote = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

/** argv 形态：必须是「非空数组且每项都是字符串」，否则视为无效。 */
export function isStringArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((a) => typeof a === 'string');
}

/**
 * 从工具参数里取出**这次调用真正会执行的 argv**。
 *
 * 与 `capabilities/shell.ts` 的执行口径**逐条对齐**：
 *   1. `params.argv` 是「非空字符串数组」→ 直接用它（执行侧优先用 argv）；
 *   2. 否则取 `params.command`（回退 `params.cmd`）→ 按引号规则切分；
 *   3. 都没有 → 空数组（表示「没有可判定的命令」）。
 *
 * 注意：执行侧在 `command` 形态下会先跑 `hasShellSyntax`（含管道/重定向就拒绝），
 * 但**那一步不改变 argv 的取法**——本函数只需要回答「若要执行，会跑哪些 token」。
 */
export function resolveArgvFromParams(params: Readonly<Record<string, unknown>>): string[] {
  const argvParam = params.argv;
  if (isStringArgv(argvParam)) return [...argvParam];
  const command = typeof params.command === 'string'
    ? params.command
    : typeof params.cmd === 'string'
      ? params.cmd
      : '';
  if (command.trim().length === 0) return [];
  return tokenizeCommandString(command);
}

/**
 * 剥掉 `cmd /c` 外壳，取出真正被 cmd 执行的那一段。
 *
 * 背景：Windows 上 `cmd /c shutdown /s` 真正跑的是 `shutdown /s`。
 * 硬拒地板若只看 argv[0]（= `cmd`），`shutdown` 就被藏在壳后面 → 逃过地板。
 * 反过来，用户也可以用 `cmd /c` 把危险命令藏起来。
 *
 * 口径：
 *   - argv[0] 匹配 `cmd` / `cmd.exe`（大小写不敏感），且 argv[1] 是 `/c` 或 `/k`
 *     → 剥掉前两个元素，继续对剩余部分递归剥壳（`cmd /c cmd /c shutdown` 也要剥两层）；
 *   - 否则原样返回。
 *
 * 只剥 `/c` 与 `/k`：这两个是「把后面整段交给 cmd 执行」的开关。
 * `/c` 是执行后退出，`/k` 是执行后保持（同样是执行后面那段）。
 */
export function stripCmdWrapper(argv: readonly string[]): string[] {
  if (argv.length < 2) return [...argv];
  const head = argv[0];
  if (!/^cmd(\.exe)?$/i.test(head)) return [...argv];
  const flag = argv[1];
  if (flag !== '/c' && flag !== '/k') return [...argv];
  return stripCmdWrapper(argv.slice(2));
}

/**
 * 取出「内联代码」——即解释器的 `-e` / `--eval` / `-c` / `-Command` 后面的那段文本。
 *
 * 这是 TD-03 的**核心**：解释器把一段任意代码当参数传进去，
 * 于是「argv[0] 看起来是 node（不在硬拒名单）」，但**实际执行的是任意代码**。
 *
 * 覆盖的解释器与其内联开关：
 *   - `node`   → `-e` / `--eval` / `-p` / `--print`
 *   - `python` → `-c`
 *   - `python3`→ 同上
 *   - `powershell` / `pwsh` → `-Command` / `-c` / `-EncodedCommand`
 *
 * 返回 `null` 表示「这不是内联代码形态」（调用方不必额外处理）。
 */
export function inlineCodeOf(argv: readonly string[]): string | null {
  if (argv.length < 2) return null;
  const exe = argv[0].toLowerCase();
  // 去掉可能的路径与扩展名：`C:\Program Files\nodejs\node.exe` → `node`
  const base = exe.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/, '');
  const switches: Record<string, readonly string[]> = {
    node: ['-e', '--eval', '-p', '--print'],
    nodejs: ['-e', '--eval', '-p', '--print'],
    python: ['-c'],
    python3: ['-c'],
    py: ['-c'],
    powershell: ['-command', '-encodedcommand'],
    pwsh: ['-command', '-encodedcommand'],
  };
  const accepted = switches[base];
  if (!accepted) return null;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i].toLowerCase();
    if (!accepted.includes(arg)) continue;
    const code = argv[i + 1];
    if (code === undefined) return ''; // 开关存在但没有代码 → 仍是内联形态
    return code;
  }
  return null;
}
