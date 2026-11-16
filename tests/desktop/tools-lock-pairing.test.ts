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
import { copyFileSync } from 'node:fs';
import { parseLockPairing, executorOfLine } from '../../tools/gate/lock-pairing';

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
    // 卡㊳：同执行方配对视图（新字段，旧三键语义不动）。锁 1＝私聊PM 被 ④ 私聊PM 的 B 型
    // 收口闭合 ⇒ sameActorClosed；锁 2＝群PM 位置式被 ③ A 型（无席名）闭合＝旧语义销，
    // 按执行方视图 ⇒ 未销（收口不可归属）。锁 2 行首有席名群PM。
    expect(res.sameActorClosedLines).toEqual([1]); // 仅锁 1（私聊PM→私聊PM）
    expect(res.unpairedByActor).toEqual({ 群PM: 1 }); // 锁 2 未被同执行方收口闭合
    expect(res.releasesUnattributable).toBe(1); // L3 A 型无席名（L4 B 型带 私聊PM）
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
      // 卡㊳：销锁判据＝同执行方可归属收口 ⇒ RELEASE 锚行筛**带群PM 席名的 B 型**（A 型无席名
      // 不判销，用它会得 exit 0＝修复本体而非缺陷；S2/S4 的验收意图是"锁被同席收口后拦"）
      const releaseLine = lines.find((l) =>
        /^[0-9]{2}-[0-9]{2} [0-9:]{5,8} \*\*群PM（[^）]{1,12}）｜RELEASE\s+[0-9a-fA-F]{7}/.test(l),
      );
      const inspLine = lines.filter((l) => /巡检 OK/.test(l)).slice(-1)[0];
      expect(claimLine, '台账应含真 CLAIM 锚行').toBeTruthy();
      expect(releaseLine, '台账应含群PM 席名 B 型真收口行（卡㊳ 销锁语义）').toBeTruthy();
      expect(inspLine, '台账应含巡检叙述行').toBeTruthy();
      // S1 真 CLAIM 无收口 ⇒ exit 0（放行）
      expect(run(`${claimLine}\n`, '群PM')).toBe(0);
      // S2 真 CLAIM＋同席真 RELEASE ⇒ exit 2（销锁生效＝拦新提交；卡㊳ 起须同执行方）
      expect(run(`${claimLine}\n${releaseLine}\n`, '群PM')).toBe(2);
      // S3 叙述行（含 RELEASE 字样＋7 位 sha）⇒ 不得销锁也不当锁 ⇒ 纯叙述 exit 2（拦）
      expect(run(`${inspLine}\n`, '群PM')).toBe(2);
      // 叙述不干扰真锁（对照格）：叙述＋真锁仍放行
      expect(run(`${inspLine}\n${claimLine}\n`, '群PM')).toBe(0);
      // S4 叙述＋真锁＋真 RELEASE ⇒ 销锁生效（叙述不得保锁）＋真 RELEASE 判据来自严格式
      expect(run(`${inspLine}\n${claimLine}\n${releaseLine}\n`, '群PM')).toBe(2);
      // 卡㊳ 互销格（06:4x L4757 归一后重定义）：真 CLAIM（群PM）＋他席**带席名**收口 ⇒ 不得销 ⇒ exit 0
      //（A 型无席名收口按位置销所有席 ⇒ 不再是互销格——改用 B 型私聊PM 收口作他席形态）
      const otherRelease = lines.find((l) => /^06:34:08 \*\*私聊PM（[^）]{1,12}）｜RELEASE\s+[0-9a-fA-F]{7}/.test(l));
      expect(otherRelease, '台账应含私聊PM 席名 B 型收口行（他席形态，L3425 实样）').toBeTruthy();
      expect(run(`${claimLine}\n${otherRelease}\n`, '群PM')).toBe(0);
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
      // 复现锁③：销锁态（同执行方可归属真收口＝B 型带席名；卡㊳ 起 A 型不判销）⇒ 拦且文案第一因
      writeFileSync(logPath, '[2026-11-16 16:40:00] CLAIM commit 群PM 试\n16:41:08 **群PM（轮询器自动收口）｜RELEASE abc1234 run 1\n', 'utf8');
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
      // 卡㊳：销锁判据＝同执行方可归属收口 ⇒ 夹具收口行改 B 型带席名（A 型无席名不判销）
      const release = '17:01:08 **群PM（轮询器自动收口）｜RELEASE abc1234 run 21';
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

// ── 卡㊲（私聊PM 派卡，2026-11-17）：执行方提取单源化——同一枚 CLAIM 行在
// 锁判定（isRealLock/structuredHeadOk）与 CLI 执行方判定（isExecutor／未在册剔除）必须同结果。
// 实样＝路线图 §十二 ⑩：`**群PM｜CLAIM commit+push 卡号…` 倒置行此前被误取卡号为执行方。
// 卡㊲ CLI 小跑器：与既有枚 9/12 同形（execSync 字符串命令；Windows 下 spawnSync('npx',…) 无 shell
// 解析不了 .cmd ⇒ status=null）。stderr 经 2>&1 并入捕获（成功路径 execSync 只回 stdout，
// 而未销锁诊断正落在 stderr）；失败时另取 err.stderr/status。退出码先落变量、不与截断同管道。
function runCheckCli(log: string, extra: string): { status: number; stderr: string } {
  try {
    const merged = execSync(`npx tsx tools/gate/lock-pairing.ts --pmlog "${log}" ${extra} 2>&1`, {
      cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stderr: merged };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { status: err.status ?? 1, stderr: (err.stderr || '') + (err.stdout || '') };
  }
}

describe('executorOfLine 单源化（卡㊲）', () => {
  it('a. 正序 CLAIM＋真 RELEASE ⇒ paired（提取式单源化后正序语义不变）', () => {
    const res = parseLockPairing('[2026-11-17 02:00:00] CLAIM commit 群PM 正序试\n[2026-11-17 02:05:00] RELEASE(挂账) abc1234 run 1\n');
    expect(res.locks).toEqual([1]);
    expect(res.pairs).toEqual([{ lockLine: 1, releaseLine: 2 }]);
    expect(executorOfLine('[2026-11-17 02:00:00] CLAIM commit 群PM 正序试')).toBe('群PM');
    expect(executorOfLine('[2026-11-17 02:00:00] CLAIM commit+push 群PM 复合动作')).toBe('群PM');
  });

  it('b. 加粗前缀＋词序倒置 ⇒ 两判据同结果：isRealLock 记锁、CLI 执行方认 群PM（修复锁）', () => {
    const line = '**群PM｜CLAIM commit+push 卡㊲ 单源化测试范围';
    // 锁判定侧：结构式前缀（加粗前缀本身就是锁行惯例）⇒ 记锁
    const res = parseLockPairing(line + '\n');
    expect(res.locks).toEqual([1]);
    // 执行方侧：单源提取认出倒置前缀的 群PM（修复前误取 卡㊲ ⇒ 未在册剔除）
    expect(executorOfLine(line)).toBe('群PM');
    // CLI 同一结果：空 actor 下该锁计入 openClaims ⇒ exit 0（修复前 exit 2＝拦合法提交）
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair37-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, line + '\n', 'utf8');
      const out = runCheckCli(log, '--check-claim 群PM');
      expect(out.status).toBe(0);
      expect(out.stderr).toContain('未销锁 CLAIM L1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('c. 倒置＋非在册执行方（Chief）⇒ 空 actor 下剔除且 stderr 带行号（记锁与剔除一致）', () => {
    const line = '**Chief｜CLAIM commit 卡㊲ 非在册倒置试';
    const res = parseLockPairing(line + '\n');
    expect(res.locks).toEqual([1]); // 锁判定侧：Chief 在 structuredHeadOk 的 actor 交替内 ⇒ 记
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair37c-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, line + '\n', 'utf8');
      const r = runCheckCli(log, '--check-claim');
      expect(r.status).toBe(2); // 空 actor＝任一在册执行方 ⇒ Chief 不在册 ⇒ 无未销锁
      expect(r.stderr).toContain('执行方未在册剔除 L1');
      expect(r.stderr).toContain('Chief');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('d. 负控：提取式退回"只认动作词之后" ⇒ (b) 倒置格必红（变异前备份、还原比逐字节相等）', () => {
    const src = join(REAL_ROOT, 'tools', 'gate', 'lock-pairing.ts');
    const bak = join(tmpdir(), `lockpair37-bak-${Date.now()}.ts`);
    copyFileSync(src, bak);
    const before = readFileSync(src, 'utf8');
    const mutated = before.replace('if (inverted) return inverted[1];', 'if (false && inverted) return inverted[1];');
    expect(mutated, '变异点必须存在（提取式实现被改名时本负控需同步）').not.toBe(before);
    const line = '**群PM｜CLAIM commit+push 卡㊲ 单源化测试范围';
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair37d-'));
    try {
      writeFileSync(src, mutated, 'utf8');
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, line + '\n', 'utf8');
      // 退回旧提取式 ⇒ exec=卡㊲ ⇒ 未在册 ⇒ exit 2（(b) 的放行面被击穿＝负控红）
      const r = runCheckCli(log, '--check-claim 群PM');
      expect(r.status, '负控：旧提取式下倒置格必须红').toBe(2);
    } finally {
      copyFileSync(bak, src);
      rmSync(bak, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(readFileSync(src, 'utf8')).toBe(before); // 还原逐字节相等（utf8 串等价＝字节等价）
  });
});

// ── 卡㊳（私聊PM 派卡，2026-11-17）：锁的闭合按**同执行方收口**判定，两 PM 不可互销；
// 收口行推不出执行方（A 型无席名）归"不可归属"档、不判销、单独计数。默认模式旧三键
// （locks／releases／unpaired）语义不动，新增 unpaired_by_actor 行。
describe('同执行方销锁（卡㊳）', () => {
  it('a. A 的 CLAIM ＋ 他席带席名收口 ⇒ A 的锁仍未销（互销格：带席名只销本席——卡㊳ 本体）', () => {
    const res = parseLockPairing('[2026-11-17 05:00:00] CLAIM commit 群PM 卡㊳ 互销格\n06:05:08 **私聊PM（轮询器自动收口）｜RELEASE abc1234 run 1\n');
    // 位置式旧语义不动：unpaired 仍 []（位置式已配对）；按执行方视图 ⇒ 他席带席名不销本席
    expect(res.unpaired).toEqual([]);
    expect(res.sameActorClosedLines).toEqual([]);
    expect(res.unpairedByActor).toEqual({ 群PM: 1 });
    // CLI：群PM 的锁仍算在途 ⇒ 放行（改前此处被 B 的收口销掉 ⇒ exit 2＝互销缺陷本体）
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair38-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, '[2026-11-17 05:00:00] CLAIM commit 群PM 卡㊳ 互销格\n06:05:08 **私聊PM（轮询器自动收口）｜RELEASE abc1234 run 1\n', 'utf8');
      const r = runCheckCli(log, '--check-claim 群PM');
      expect(r.status, '他席带席名收口不得销本席锁（改前 exit 2＝互销）').toBe(0);
      expect(r.stderr).toContain('未销锁 CLAIM L1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('b. A 的 CLAIM ＋ A 的收口行 ⇒ 销（sameActorClosed＋CLI exit 2）', () => {
    const res = parseLockPairing('[2026-11-17 05:10:00] CLAIM commit 群PM 卡㊳ 自销格\n06:11:08 **群PM（轮询器自动收口）｜RELEASE abc1234 run 2\n');
    expect(res.sameActorClosedLines).toEqual([1]);
    expect(res.unpairedByActor).toEqual({});
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair38b-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, '[2026-11-17 05:10:00] CLAIM commit 群PM 卡㊳ 自销格\n06:11:08 **群PM（轮询器自动收口）｜RELEASE abc1234 run 2\n', 'utf8');
      const r = runCheckCli(log, '--check-claim 群PM');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('无未销锁 CLAIM');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('c. A 的 CLAIM ＋ 无执行方 A 型收口 ⇒ 裁定（L4757）按位置销所有席 ⇒ 拦＋保留计数提示', () => {
    const res = parseLockPairing('[2026-11-17 05:20:00] CLAIM commit 群PM 卡㊳ 无主收口格\n[2026-11-17 05:25:00] RELEASE(挂账) abc1234 run 3\n');
    expect(res.releasesUnattributable).toBe(1);
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair38c-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, '[2026-11-17 05:20:00] CLAIM commit 群PM 卡㊳ 无主收口格\n[2026-11-17 05:25:00] RELEASE(挂账) abc1234 run 3\n', 'utf8');
      const r = runCheckCli(log, '--check-claim 群PM');
      // 06:4x 归一：A 型位置销（防私聊PM 侧恒放行＝放开越权面）；计数与提示保留（可观测面）
      expect(r.status, 'A 型位置销 ⇒ 锁已销 ⇒ 拦（per-actor 版曾返 0）').toBe(2);
      expect(r.stderr).toContain('不可归属');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('d. 负控：带席名销锁判定退回位置式（他席收口也销本席）⇒ (a) 互销格必红（备份→变异→红→还原→逐字节比）', () => {
    const src = join(REAL_ROOT, 'tools', 'gate', 'lock-pairing.ts');
    const bak = join(tmpdir(), `lockpair38-bak-${Date.now()}.ts`);
    copyFileSync(src, bak);
    const before = readFileSync(src, 'utf8');
    // 变异：soldBy 里带席名分支改回"任何带席名收口都销"（跨席互销复活）
    const mutated = before.replace(
      'if (lockActor !== undefined && relActor === lockActor) return true; // ① 带席名只销本席',
      'if (lockActor !== undefined) return true; // 变异：任何带席名收口都销＝跨席互销复活',
    );
    expect(mutated, '变异点必须存在（判定行被改名时本负控需同步）').not.toBe(before);
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair38d-'));
    try {
      writeFileSync(src, mutated, 'utf8');
      const log = join(tmp, 'PM-LOG.md');
      // (a) 互销格：群PM 锁＋私聊PM 带席名收口 ⇒ 变异下销掉 ⇒ exit 2＝负控红
      writeFileSync(log, '[2026-11-17 05:00:00] CLAIM commit 群PM 卡㊳ 互销格\n06:05:08 **私聊PM（轮询器自动收口）｜RELEASE abc1234 run 1\n', 'utf8');
      const r = runCheckCli(log, '--check-claim 群PM');
      expect(r.status, '负控：跨席互销复活后 (a) 必红（exit 2）').toBe(2);
    } finally {
      copyFileSync(bak, src);
      rmSync(bak, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(readFileSync(src, 'utf8')).toBe(before);
  });

  it('e. 正控（群PM 06:1x 裁定）：窗口前有同执行方历史锁＋窗口内零新锁 ⇒ 该执行方必须 EXIT=2（窗口外历史锁不顶门）', () => {
    // 夹具：L1 群PM 锁＋L2 A 型收口（旧位置式销掉）＋L3 B 型群PM 收口 ＋ L4 私聊PM 锁＋L5 私聊PM B 型收口
    // ⇒ lastRelease=L5；群PM 的 L1 锁在窗口外 ⇒ 不得顶开 door ⇒ exit 2
    const body = [
      '[2026-11-17 06:20:00] CLAIM commit 群PM 窗口外历史锁',
      '[2026-11-17 06:21:00] RELEASE(挂账) abc0001 run 1',
      '06:22:08 **群PM（轮询器自动收口）｜RELEASE abc0002 run 2',
      '[2026-11-17 06:23:00] CLAIM commit 私聊PM 窗口内新锁',
      '06:24:08 **私聊PM（轮询器自动收口）｜RELEASE abc0003 run 3',
    ].join('\n');
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair38e-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, body + '\n', 'utf8');
      const r = runCheckCli(log, '--check-claim 群PM');
      expect(r.status, '窗口外历史锁不得顶开门：窗口内零新锁 ⇒ 拦（06:0x 版曾返 0）').toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('f. 互证：窗口内新锁只跟 A 型收口 ⇒ 仍 EXIT=2（不可归属收口不判销）＋跨席对照', () => {
    // per-actor 窗口下：群PM 无历史带席名收口 ⇒ 窗口起点 0 ⇒ L1 锁在窗内。
    // L1 群PM 锁＋L2 A 型无席名收口 ⇒ 不判销 ⇒ 在途 ⇒ 放行；跨席＝私聊PM 带席名收口 ⇒ 仍放行
    // （A 型与他席收口都不销群PM 的锁——这一格两态都是 0，销锁面由 (b) 与负控 (d) 锁死）
    const bodyA = '[2026-11-17 06:30:00] CLAIM commit 群PM 窗口内锁\n[2026-11-17 06:31:00] RELEASE(挂账) abc0004 run 4\n';
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair38f-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, bodyA, 'utf8');
      // 卡㊳ 归一（L4757）：A 型不可归属收口按位置销所有席 ⇒ 锁已销 ⇒ 拦（per-actor 版曾返 0）
      expect(runCheckCli(log, '--check-claim 群PM').status, 'A 型位置销 ⇒ 锁已销 ⇒ 拦').toBe(2);
      const bodyB = '[2026-11-17 06:30:00] CLAIM commit 群PM 窗口内锁\n06:31:08 **私聊PM（轮询器自动收口）｜RELEASE abc0005 run 5\n';
      writeFileSync(log, bodyB, 'utf8');
      expect(runCheckCli(log, '--check-claim 群PM').status, '他席带席名收口不销本席锁 ⇒ 在途 ⇒ 放行').toBe(0);
      // 对照格：同席带席名收口 ⇒ 销 ⇒ 拦（这一枚把 (f) 的两面锁死）
      const bodyC = '[2026-11-17 06:30:00] CLAIM commit 群PM 窗口内锁\n06:31:08 **群PM（轮询器自动收口）｜RELEASE abc0006 run 6\n';
      writeFileSync(log, bodyC, 'utf8');
      expect(runCheckCli(log, '--check-claim 群PM').status, '同席带席名收口 ⇒ 销 ⇒ 拦').toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('g. 裁定格（群PM 06:4x L4757 归一）：A 型不可归属收口按位置销所有席 ⇒ 同席锁 EXIT=2（本格在 06:2x 版上红）', () => {
    // L1 群PM 锁（带 sha 引用 f3e59e6）＋L2 A 型无席名收口（sha abc1234 与锁不等 ⇒ sha 配对
    // 自愈不出）⇒ 按裁定 A 型位置销 ⇒ 拦。06:2x per-actor 版（A 型不判销）上此格返 0＝红。
    const body = '[2026-11-17 06:30:00] CLAIM commit 群PM 窗口内锁 f3e59e6\n[2026-11-17 06:31:00] RELEASE(挂账) abc1234 run 4\n';
    const tmp = mkdtempSync(join(tmpdir(), 'lockpair38g-'));
    try {
      const log = join(tmp, 'PM-LOG.md');
      writeFileSync(log, body, 'utf8');
      expect(runCheckCli(log, '--check-claim 群PM').status, 'A 型位置销 ⇒ 拦（per-actor 版曾返 0）').toBe(2);
      // sha 配对自愈对照格：收口 sha 与锁行 sha 相等 ⇒ 强配对判销（不依赖席名，也在窗口语义内）
      const body2 = '[2026-11-17 06:30:00] CLAIM commit 群PM 窗口内锁 f3e59e6\n[2026-11-17 06:31:00] RELEASE(挂账) f3e59e6 run 4\n';
      writeFileSync(log, body2, 'utf8');
      expect(runCheckCli(log, '--check-claim 群PM').status, 'sha 配对 ⇒ 判销 ⇒ 拦（自愈出口）').toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
