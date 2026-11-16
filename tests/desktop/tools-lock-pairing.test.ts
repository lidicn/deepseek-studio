/**
 * 卡⑰ lock-pairing 契约：判据从 logs/pmg-lock-check.ps1 逐条冻结移植，测试锁住
 * 两枚当天最贵的牙（叙述裸词不计入／PM 手填漏括号的锚定式不得命中）＋两型收口＋
 * 未配对复算＋空表＋台账缺席 N/A＋真实仓现跑（期望值现算，与 ps1 同命令互证）。
 */
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as pmsafeModule from '../../tools/gate/pmsafe';
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLockPairing } from '../../tools/gate/lock-pairing';

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_PMLOG = join(REAL_ROOT, 'PM-LOG.md');

describe('lock-pairing · 合成夹具（卡⑰）', () => {
  it('1. 两型收口各命中＋配对与未配对复算（批次释放共享＋末锁无后续 ⇒ 未配对）', () => {
    const text = [
      '[2026-11-16 10:00:00] CLAIM commit 群PM 10:00 第一笔',
      '**群PM｜CLAIM push 群PM 10:10 第二笔**',
      '[2026-11-16 10:15:00] RELEASE(挂账) abc1234 run 111 in_progress', // 一发释放收两枚锁（批次释放共享）
      '**群PM（轮询器自动收口）｜RELEASE def5678 run 222 completed/success**', // B 型实样形态
      '[2026-11-16 10:20:00] CLAIM tag 群PM 10:20 第三笔（其后无收口）',
    ].join('\n');
    const res = parseLockPairing(text);
    expect(res.locks).toEqual([1, 2, 5]);
    expect(res.releases).toEqual([3, 4]); // A 型＋B 型
    // 配对＝逐枚锁找其后首条收口：1→3（3 在其后）、2→3（3 也在其后，共享）；5 号锁其后无收口 ⇒ 未配对
    expect(res.pairs).toEqual([
      { lockLine: 1, releaseLine: 3 },
      { lockLine: 2, releaseLine: 3 },
    ]);
    expect(res.unpaired).toEqual([5]); // ⑰-补3/4 语义不变：末锁无后续收口如实报
    expect(res.lastLockLine).toBe(5);
    expect(res.lastReleaseLine).toBe(4);
  });

  it('2. 牙①：PM 手填漏括号的锚定式不得命中（`…收口｜RELEASE` 无行首机器锚、括号残缺）', () => {
    const text = [
      '[2026-11-16 14:41:14] 巡检： RELEASE 式应为 `轮询器自动收口｜RELEASE 21707f6 …`（手填字面）',
      '按手填字面写：轮询器自动收口｜RELEASE 21707f6（漏右括号）',
    ].join('\n');
    const res = parseLockPairing(text);
    expect(res.releases).toEqual([]); // 两型都不命中——照它跑会把全部锁判成未闭
  });

  it('3. 牙②：叙述行裸词 CLAIM／RELEASE 不计入（当天最贵的一枚）', () => {
    const text = [
      '日常 commit／push 由任一 PM 在落 CLAIM 后执行',
      'RELEASE 21707f6 已经落账（行首无锚，不计）',
      '判据原文：CLAIM\\s+(commit|push|tag)——正则叙述行不判',
      '上一条说「RELEASE 21707f6 已落」属叙述引用（行首无锚）',
    ].join('\n');
    const res = parseLockPairing(text);
    expect(res.locks).toEqual([]); // 四行叙述，无一是真 CLAIM 锁
    expect(res.releases).toEqual([]); // 行首无锚的 RELEASE 一律不计
  });

  it('4. 未配对：末尾锁无后续收口 ⇒ 列行号（期望非空场景）', () => {
    const text = [
      '[2026-11-16 10:00:00] CLAIM commit 群PM 10:00 老闸',
      '[2026-11-16 10:05:00] RELEASE(挂账) aaa1111 run 1',
      '[2026-11-16 11:00:00] CLAIM push 群PM 11:00 新闸（尚未收口）',
    ].join('\n');
    const res = parseLockPairing(text);
    expect(res.unpaired).toEqual([3]);
    expect(res.pairs).toEqual([{ lockLine: 1, releaseLine: 2 }]);
  });

  it('5. 空表／仅空白不报错', () => {
    const empty = parseLockPairing('');
    expect(empty.locks).toEqual([]);
    expect(empty.releases).toEqual([]);
    expect(empty.unpaired).toEqual([]);
    expect(empty.structure.lines).toBe(0);
    const blank = parseLockPairing('\n\n');
    expect(blank.structure.lines).toBe(2); // Get-Content 口径：两个空行、无锁无收口、不报错
  });

  it('6. 尾换行不计空尾行（ps1 Get-Content 口径对齐）', () => {
    const res = parseLockPairing('[2026-11-16 10:00:00] CLAIM commit x\n');
    expect(res.structure.lines).toBe(1);
  });

  it('7. ⑰-补 牙③：最狠负样本——行首带时间戳锚、正文含裸 CLAIM／RELEASE、行内带 ≥7 位 sha 的叙述行，不得计入', () => {
    // 2026-11-16 四次手填错全栽在这类行（L4197 真身：正文引判据原文＋带 sha）
    const text = [
      '[2026-11-16 14:08:41] 谈判记录：某席说「RELEASE 21707f6 已经落账」、又引判据 CLAIM\\s+(commit|push|tag)，本行 sha=abc1234 只是正文文本',
      '[2026-11-16 14:06:31] CLAIM commit+push 群PM 14:06 docs 勘误批（真锁）',
      '[2026-11-16 14:10:17] RELEASE(挂账) 21707f6 勘误批收口（真收口）',
    ].join('\n');
    const res = parseLockPairing(text);
    expect(res.locks).toEqual([2]); // 第 1 行三要素齐全仍不算
    expect(res.releases).toEqual([3]);
    expect(res.unpaired).toEqual([]);
  });

  it('8. ⑰-补 判据 ②：纯读证明——CLI 跑一遍，输入文件字节＋mtime 前后全等（不喂养台账）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair-ro-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      // ⑰-补 exit 语义下夹具必须全配对（unpaired>0 会 exit 1 抛错）——纯读证明与退出码正交
      writeFileSync(log, '[2026-11-16 10:00:00] CLAIM commit x\n[2026-11-16 10:05:00] RELEASE(挂账) abc1234 run 1\n', 'utf8');
      const before = readFileSync(log);
      const beforeM = statSync(log).mtimeMs;
      execSync(`npx tsx tools/gate/lock-pairing.ts --pmlog "${log}"`, {
        cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      expect(Buffer.compare(before, readFileSync(log))).toBe(0);
      expect(statSync(log).mtimeMs).toBe(beforeM);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('9. ⑰-补 判据 ③：unpaired>0 ⇒ CLI exit 1；全配对 ⇒ exit 0（合成台账，两态都真跑）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair-exit-'));
    const run = (body: string): number => {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, body, 'utf8');
      try {
        execSync(`npx tsx tools/gate/lock-pairing.ts --pmlog "${log}"`, {
          cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? 1;
      }
    };
    try {
      const unpaired = run('[2026-11-16 10:00:00] CLAIM commit x\n');
      expect(unpaired, '未闭合锁存在应 exit 1').toBe(1);
      const paired = run('[2026-11-16 10:00:00] CLAIM commit x\n[2026-11-16 10:05:00] RELEASE(挂账) abc1234 run 1\n');
      expect(paired, '全配对应 exit 0').toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('lock-pairing · CLI 与真实仓现跑（期望值现算）', () => {
  it('7. CLI 真实仓：与 ps1 同命令互证（locks/releases/unpaired 逐键相等，非写死）', () => {
    // ⑰-补3（群PM 判据）：CI 干净检出无 PM-LOG／ps1（gitignored）——两件缺任一都不得走到
    // execSync（否则 ps1 一缺失就炸用例）；显式打印 N/A 让 CI 日志看见"这枚没判"，不伪装绿
    const PS1 = join(REAL_ROOT, 'logs', 'pmg-lock-check.ps1');
    if (!existsSync(REAL_PMLOG) || !existsSync(PS1)) {
      console.log('N/A：CI 无 PM-LOG／ps1，本枚互证未判');
      return;
    }
    const tsx = (args: string) => {
      try {
        return execSync(`npx tsx ${args}`, { cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        // ⑰-补3 后真实台账可能 unpaired>0（活件）⇒ CLI exit 1 抛错——互证取 stdout 对平，
        // 退出码语义由枚 9 专锁，这里不判 exit
        return (e as { stdout?: string }).stdout ?? '';
      }
    };
    // ps1 侧（判据源件）
    const ps1Out = execSync('pwsh -NoProfile -File logs/pmg-lock-check.ps1', {
      cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parse = (s: string) =>
      new Map(
        s
          .trim()
          .split(/\r?\n/)
          .map((l) => [l.split('=')[0], l.split('=').slice(1).join('=')]),
      );
    const ps1 = parse(ps1Out);
    // ts 侧
    const out = tsx('tools/gate/lock-pairing.ts');
    const ts = parse(out);
    for (const key of ['locks', 'releases', 'h2', 'h3', 'lines', 'bytes']) {
      expect(ts.get(key), `${key} 应与 ps1 逐字同`).toBe(ps1.get(key));
    }
    // unpaired 两口径独立复算（⑰-补3：台账活件、新 CLAIM 随时落——不得把当天的 0 写成死锚；
    // 锁正则的叙述污染行（巡检正文含 CLAIM commit+push 字样）计入是冻结判据的已知边界，
    // 两实现必须同错（逐键相等），语义层由牙②夹具与 CLI exit 锁分立守住
    const unpairedTs = Number(ts.get('unpaired'));
    const unpairedPs1 = Number(ps1.get('unpaired'));
    expect(unpairedTs).toBe(unpairedPs1);
    expect(unpairedTs).toBeGreaterThanOrEqual(0);
  });

  it('7b. ⑰-补3 最狠负样本：行首真锁＋同一行句中引用字样 ⇒ 只计 1 枚；巡检叙述行 0 枚', () => {
    const text = [
      '[2026-11-16 15:10:42] CLAIM commit 群PM 卡⑰ 入库（本行后面复述判据 CLAIM\\s+(commit|push|tag) 不另计）',
      '[2026-11-16 15:12:50] 巡检 OK｜读数同命令现算：dirty=2（暂存区＝卡⑰ 两枚，按 CLAIM commit+push 判位）',
    ].join('\n');
    const res = parseLockPairing(text);
    expect(res.locks).toEqual([1]); // 第 2 行句中"按 CLAIM commit+push 判位"不计
    expect(res.unpaired).toEqual([1]); // 无收口 ⇒ 未配对如实报
  });

  it('7c. ⑰-补4 四枚：## @时刻／### [..]／裸时刻锚+括注 真锁真收口计入；句读叙述行不计；dropped 带被剔行号', () => {
    const text = [
      '## @2026-11-15 03:30:57 CLAIM commit+push 私聊PM AGENTS 补条', // ① 标题锚真锁
      '### [04:58] CLAIM commit+push 群PM ③ 闸侧标记法', // ② 小节锚真锁
      '[2026-11-15 08:38:44] RELEASE(挂账) abc1234 run 1',
      '06:34:08 **私聊PM（轮询器自动收口）｜RELEASE def5678 CI run 2 = completed/success**', // ③ 裸时刻锚＋括注 B 型真收口
      '- **⑤ 回炉第 1 条**：实测形态「落 CLAIM commit 后执行」，本行是叙述（含句读，剔）', // ④ 句读叙述行（loose 命中、位置判据剔）
    ].join('\n');
    const res = parseLockPairing(text);
    expect(res.locks).toEqual([1, 2]); // ①② 计入，④ 叙述不计
    expect(res.releases).toEqual([3, 4]); // A 型＋③ B 型
    expect(res.pairs).toEqual([
      { lockLine: 1, releaseLine: 3 },
      { lockLine: 2, releaseLine: 3 },
    ]);
    expect(res.unpaired).toEqual([]); // 全配对（1→3、2→3）
    expect(res.dropped.map((d) => d.line)).toEqual([5]); // 唯一被剔＝叙述行，行号在 dropped 清单
  });

  it('8. CLI：台账缺席 ⇒ N/A exit 0（缺失≠干净）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair-'));
    try {
      const missing = join(tmp, 'no-such-PM-LOG.md');
      let out = '';
      let code = 0;
      try {
        out = execSync(`npx tsx tools/gate/lock-pairing.ts --pmlog "${missing}"`, {
          cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch (e) {
        code = (e as { status?: number }).status ?? 1;
        out = (e as { stdout?: string }).stdout ?? '';
      }
      expect(code).toBe(0);
      expect(out).toContain('N/A');
      expect(out).toContain('本步未判');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('10. 卡⑱ --check-claim：真实人口四态（真台账片段驱动，非合成短语）', () => {
    if (!existsSync(REAL_PMLOG)) {
      console.log('N/A：CI 无 PM-LOG／ps1，本枚未判');
      return;
    }
    const real = readFileSync(REAL_PMLOG, 'utf8');
    const lines = real.split(/\r?\n/);
    const tmp = mkdtempSync(join(tmpdir(), 'hook18-'));
    const run = (body: string, actor: string): number => {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, body, 'utf8');
      try {
        execSync(`npx tsx tools/gate/lock-pairing.ts --pmlog "${log}" --check-claim "${actor}"`, {
          cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? 1;
      }
    };
    try {
      // 真台账锚行（现读，非写死行号）——RELEASE 用严格式筛（裸字样会抓到叙述行）
      const claimLine = lines.find((l) => /^\[2026-11-16 15:10:42\] CLAIM/.test(l));
      const releaseLine = lines.find((l) =>
        /^\[[0-9-]{10} [0-9:]{8}\] RELEASE(?:\([^)]*\)|（[^）]*）)?\s+[0-9a-fA-F]{7}/.test(l),
      );
      const inspLine = lines.filter((l) => /巡检 OK/.test(l)).slice(-1)[0];
      expect(claimLine, '台账应含真 CLAIM 锚行').toBeTruthy();
      expect(releaseLine, '台账应含真 RELEASE 锚行').toBeTruthy();
      expect(inspLine, '台账应含巡检叙述行').toBeTruthy();
      // S1 真 CLAIM 无收口 ⇒ exit 0（放行）
      expect(run(`${claimLine}\n`, '群PM')).toBe(0);
      // S2 真 CLAIM＋真 RELEASE ⇒ exit 2（销锁生效＝拦新提交）
      expect(run(`${claimLine}\n${releaseLine}\n`, '群PM')).toBe(2);
      // S3 叙述行（含 RELEASE 字样＋7 位 sha）⇒ 不得销锁也不当锁 ⇒ 纯叙述 exit 2（拦）
      expect(run(`${inspLine}\n`, '群PM')).toBe(2);
      // 叙述不干扰真锁（对照格）：叙述＋真锁仍放行
      expect(run(`${inspLine}\n${claimLine}\n`, '群PM')).toBe(0);
      // S4 叙述＋真锁＋真 RELEASE ⇒ 销锁生效（叙述不得保锁）＋真 RELEASE 判据来自严格式
      expect(run(`${inspLine}\n${claimLine}\n${releaseLine}\n`, '群PM')).toBe(2);
      // actor 隔离：真锁属 群PM，按 私聊PM 判 ⇒ 无未销锁 ⇒ 拦
      expect(run(`${claimLine}\n`, '私聊PM')).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('11. 卡⑱ 钩单一真相：安装器产物不含 awk 解析段、含 --check-claim 调用（判据单源）', () => {
    const installer = readFileSync(resolve(REAL_ROOT, 'scripts', 'install-pre-commit-hook.mjs'), 'utf8');
    expect(installer).toContain('--check-claim');
    expect(installer).not.toMatch(/awk -v actor/); // 旧 awk 判据段已删
    expect(installer).not.toMatch(/tail -n 40/); // 末 40 行窗口已废（⑱-②）
  });

  it('12. 卡⑲ 拦下文案三因分立：exit 2＝无未销锁 CLAIM／工具失败＝npx 不可用（假 PATH 实测）／PM-LOG 缺失', () => {
    const installer = readFileSync(resolve(REAL_ROOT, 'scripts', 'install-pre-commit-hook.mjs'), 'utf8');
    expect(installer).toContain('没有未销锁的 CLAIM commit 记录');
    expect(installer).toContain('工具执行失败（npx tsx 缺失或非预期退出）');
    expect(installer).toContain('PM-LOG.md 不存在');
    if (existsSync(REAL_PMLOG)) {
      const inspLine = readFileSync(REAL_PMLOG, 'utf8').split(/\r?\n/).filter((l) => /巡检 OK/.test(l)).slice(-1)[0];
      const tmp = mkdtempSync(join(tmpdir(), 'hook19-'));
      try {
        const log = join(tmp, 'PM-LOG.md');
        writeFileSync(log, inspLine, 'utf8');
        const r = spawnSync(process.execPath, [
          '--import', 'tsx', join(REAL_ROOT, 'tools', 'gate', 'lock-pairing.ts'), '--pmlog', log, '--check-claim', '群PM',
        ], { cwd: REAL_ROOT, encoding: 'utf8' });
        expect(r.status, '纯叙述无真锁应 exit 2（第一因）').toBe(2);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const tmp2 = mkdtempSync(join(tmpdir(), 'hook19-nopath-'));
    try {
      const log = join(tmp2, 'PM-LOG.md');
      writeFileSync(log, '[2026-11-16 16:30:00] CLAIM commit 群PM 试\n', 'utf8');
      const r = spawnSync('npx', ['tsx', join(REAL_ROOT, 'tools', 'gate', 'lock-pairing.ts'), '--pmlog', log, '--check-claim', '群PM'], {
        cwd: tmp2,
        encoding: 'utf8',
        env: { ...process.env, PATH: 'C:\\Windows\\System32;C:\\Windows' },
      });
      expect(r.status, 'npx 不可用应非预期退出（非 0/2 的失败态）').not.toBe(2);
      expect(r.status ?? -1, '工具失败态不该是 exit 0（放行）').not.toBe(0);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('13. 卡⑳ tmp 仓真跑钩：绝对 CLI（GATE_LOCK_CLI 注入）＋假 PATH 双因分派——CI 连红根因的复现与修复锁', () => {
    // CI 连红根因（群PM 现读）：钩与夹具用相对路径 tools/gate/lock-pairing.ts，tmp 仓无该文件
    // ⇒ ERR_MODULE_NOT_FOUND ⇒ 文案/退出码全偏。复现条件＝tmp 仓＋暂存非空＋cwd 在 tmp 仓。
    const installerPath = resolve(REAL_ROOT, 'scripts', 'install-pre-commit-hook.mjs');
    const tmpRepo = mkdtempSync(join(tmpdir(), 'hook20-repo-'));
    const logPath = join(tmpRepo, 'PM-LOG.md');
    writeFileSync(logPath, '[2026-11-16 16:40:00] CLAIM commit 群PM 试（真片段形态，非合成短语）\n', 'utf8');
    execSync('git init', { cwd: tmpRepo, encoding: 'utf8' });
    execSync('git config user.email t@t', { cwd: tmpRepo, encoding: 'utf8' });
    execSync('git config user.name t', { cwd: tmpRepo, encoding: 'utf8' });
    writeFileSync(join(tmpRepo, 'probe.js'), 'probe', 'utf8');
    execSync('git add probe.js', { cwd: tmpRepo, encoding: 'utf8' });
    // 在 tmp 仓装钩（安装器读 git toplevel=tmp 仓），钩从 tmp 仓 cwd 真跑
    execSync(`node "${installerPath}"`, { cwd: tmpRepo, encoding: 'utf8' });
    try {
      // 复现 CI 红的条件：不注入 GATE_LOCK_CLI（⑱ 版钩相对路径在这必炸）——修复版钩的
      // lock_cli 默认 `$top/tools/gate/...` 在 tmp 仓也不存在 ⇒ 仍炸，但 ERR 形态可验
      const rBad = spawnSync('git', ['commit', '-m', 'probe'], {
        cwd: tmpRepo,
        encoding: 'utf8',
        env: { ...process.env, GATE_ACTOR: '群PM' },
      });
      // 修复锁：tmp 仓跑钩必被拦（没有 node_modules）且文案是第二因（工具执行失败），非第一因
      expect(rBad.status, 'tmp 仓无依赖环境应拦提交').toBe(1);
      const err = rBad.stderr ?? '';
      expect(err).toContain('工具执行失败（npx tsx 缺失或非预期退出）');
      expect(err).not.toContain('没有未销锁的 CLAIM commit 记录'); // 三因不共用标题
      // 修复锁②：注入 GATE_LOCK_CLI ⇒ CLI 真跑 ⇒ 判定走真实判据（真片段：CLAIM 未收口 ⇒ 放行）
      const rGood = spawnSync('git', ['commit', '-m', 'probe'], {
        cwd: tmpRepo,
        encoding: 'utf8',
        env: { ...process.env, GATE_ACTOR: '群PM', GATE_LOCK_CLI: join(REAL_ROOT, 'tools', 'gate', 'lock-pairing.ts') },
      });
      expect(rGood.status, '注入绝对 CLI 后按真实判据放行（CLAIM 未销锁）').toBe(0);
      // rGood 已提交 probe.js ⇒ 需新 staged 文件才触发钩（钩检查暂存非空才跑）
      writeFileSync(join(tmpRepo, 'probe2.js'), 'probe2', 'utf8');
      execSync('git add probe2.js', { cwd: tmpRepo, encoding: 'utf8' });
      // 复现锁③：销锁态（真收口行）⇒ 拦且文案第一因
      writeFileSync(logPath, '[2026-11-16 16:40:00] CLAIM commit 群PM 试\n[2026-11-16 16:41:00] RELEASE(挂账) abc1234 run 1\n', 'utf8');
      const rSold = spawnSync('git', ['commit', '-m', 'probe2'], {
        cwd: tmpRepo,
        encoding: 'utf8',
        env: { ...process.env, GATE_ACTOR: '群PM', GATE_LOCK_CLI: join(REAL_ROOT, 'tools', 'gate', 'lock-pairing.ts') },
      });
      expect(rSold.status, '销锁态应拦').toBe(1);
      expect(rSold.stderr ?? '').toContain('没有未销锁的 CLAIM commit 记录');
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('14. 卡⑳ pmsafe 双时刻防御：正文开头带时间戳的块 ⇒ 拒写（CLAIM 不落锁的绕过面）', () => {
    const { safeAppendBlock } = pmsafeModule;
    const tmp = mkdtempSync(join(tmpdir(), 'pmsafe20-'));
    try {
      const big = join(tmp, 'PM-LOG.md');
      writeFileSync(big, 'x'.repeat(100 * 1024) + '\n', 'utf8'); // 过 MIN_LOG_BYTES 闸
      let threw = '';
      try {
        safeAppendBlock(big, '[2026-11-16 16:34:19] CLAIM commit 群PM 双时刻正文（机器锚会叠加）');
      } catch (e) {
        threw = (e as Error).message;
      }
      expect(threw).toContain('正文开头已带时间戳');
      // 正常块仍可写（回归面）
      safeAppendBlock(big, 'CLAIM commit 群PM 正常块无正文锚');
      expect(readFileSync(big, 'utf8')).toContain('正常块无正文锚');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('15. 卡㉑ --check-claim 空 actor／缺参同分支＋执行方通用化（钩默认路径的 CLI 级行为锁）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair21-'));
    const run = (body: string, ...cli: string[]): number => {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, body, 'utf8');
      try {
        execSync(`npx tsx tools/gate/lock-pairing.ts --pmlog "${log}" ${cli.join(' ')}`, {
          cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? 1;
      }
    };
    try {
      const claim = '[2026-11-16 17:00:00] CLAIM commit 群PM 卡㉑ 夹具（真行形态）';
      const release = '[2026-11-16 17:01:00] RELEASE(挂账) abc1234 run 21';
      const claimSep = '[2026-11-16 17:02:00] CLAIM commit+push 群PM｜④②c 入库分两笔（真台账形态：执行方后接分隔符）';
      // 缺参：--check-claim 不带参 ⇒ 落空串分支（钩不设 GATE_ACTOR 的默认路径）；真带名锁 ⇒ 放行
      expect(run(`${claim}\n`, '--check-claim')).toBe(0);
      // 传空串：显式 '' ⇒ 任一在册执行方 ⇒ 放行（两入口同分支，一并锁死）
      expect(run(`${claim}\n`, '--check-claim', '""')).toBe(0);
      // 空 actor ＋ 已销锁 ⇒ 拦（任一模式也认锁状态）
      expect(run(`${claim}\n${release}\n`, '--check-claim')).toBe(2);
      // 执行方后接分隔符的真台账形态（群PM｜…）：捕获停在分隔符上，具名仍比中 ⇒ 放行
      expect(run(`${claimSep}\n`, '--check-claim', '群PM')).toBe(0);
      // gate-test：⑤ 套件合成执行方——通用化前不被 (群PM|私聊PM) 识别 ⇒ 拦（旧缺陷锁）
      expect(run('CLAIM commit gate-test 08:15 测试\n', '--check-claim', 'gate-test')).toBe(0);
      // ㉑-加闸格①（群PM 探针裁定）：空 actor ＋非在册执行方名 ⇒ 拦（越权绕过面，exit 2）
      expect(run('[2026-11-16 09:00:00] CLAIM commit 假执行方 卡ZZ 有人随手编的执行方名\n', '--check-claim')).toBe(2);
      // ㉑-加闸格②：具名 gate-test ＋同一条非在册锁 ⇒ 放行（具名入口不查名册，⑤ 族保命格）
      expect(run('CLAIM commit gate-test 08:15 测试\n', '--check-claim', 'gate-test')).toBe(0);
      // 具名隔离不破：私聊PM 判 群PM 的锁 ⇒ 无未销锁 ⇒ 拦
      expect(run(`${claim}\n`, '--check-claim', '私聊PM')).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('9. CLI --pmlog 指向合成台账：读数与 parseLockPairing 纯函数一致（参数化生效）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair2-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(
        log,
        '[2026-11-16 10:00:00] CLAIM commit 群PM 10:00 试\n[2026-11-16 10:05:00] RELEASE(挂账) c0ffee1 run 9\n',
        'utf8',
      );
      const out = execSync(`npx tsx tools/gate/lock-pairing.ts --pmlog "${log}"`, {
        cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      expect(out).toContain('locks=1');
      expect(out).toContain('releases=1');
      expect(out).toContain('unpaired=0');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
