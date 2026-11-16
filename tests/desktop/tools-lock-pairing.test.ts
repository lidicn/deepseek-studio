/**
 * 卡⑰ lock-pairing 契约：判据从 logs/pmg-lock-check.ps1 逐条冻结移植，测试锁住
 * 两枚当天最贵的牙（叙述裸词不计入／PM 手填漏括号的锚定式不得命中）＋两型收口＋
 * 未配对复算＋空表＋台账缺席 N/A＋真实仓现跑（期望值现算，与 ps1 同命令互证）。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
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
