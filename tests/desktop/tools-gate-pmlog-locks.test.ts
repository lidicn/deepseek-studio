/**
 * ⑧/⑧-补 pmlog-locks 契约（20261115 群PM 派卡＋退回补课）：
 * 收口形态全集（END／CLOSED／GATE#n 收口／裸#n 作废+ABORTED／无号 GATE_EXIT= 30 行窗／
 * 行首 FREE 锚定）＋四态分类（open/closed/closed-aborted/reference-only）＋⑧-补 ①
 * 「RUNNING 字面一律算起跑过」两枚真实行形态夹具（#96 L2636／#99 L3306+L3318 形态）＋
 * Chief 验收锚（#23 必 aborted、#27 必 closed）＋真实仓现跑＋N/A 面＋只读证明。
 * 汇总值现算不写死（写死＝明天的死锚）。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGateLocks, scanGateProcesses } from '../../tools/gate/pmlog-locks';

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_PMLOG = join(REAL_ROOT, 'PM-LOG.md');

describe('pmlog-locks · 合成夹具（⑧/⑧-补）', () => {
  it('1. 收口形态各一枚：END／CLOSED／GATE#n 收口／FREE(收口)', () => {
    const text = [
      'RUNNING GATE#1 by A',
      'END GATE#1 GATE_EXIT=0',
      'RUNNING GATE#2 by B',
      'GATE#2 收口 = 绿',
      'RUNNING GATE#3 by C',
      'CLOSED GATE#3 exit=0',
      'RUNNING GATE#4 by D',
      'FREE gate#4 npm run gate（12:00 收口 GATE_EXIT=0）',
    ].join('\n');
    const { records, referenceOnly } = parseGateLocks(text);
    expect(records.filter((r) => r.status === 'open')).toHaveLength(0);
    expect(records.filter((r) => r.status === 'closed')).toHaveLength(4);
    expect(referenceOnly).toHaveLength(0);
    const byN = new Map(records.map((r) => [r.n, r]));
    expect(byN.get(1)?.form).toBe('END GATE#n');
    expect(byN.get(2)?.form).toBe('GATE#n 收口');
    expect(byN.get(3)?.form).toBe('CLOSED GATE#n');
    expect(byN.get(4)?.form).toBe('FREE(收口)');
    expect(byN.get(4)?.status).toBe('closed'); // 带「收口 GATE_EXIT=」证据的 FREE 是完成不是中止
  });

  it('2. 真实台账形态：间隔收口／叙述闭合／⑧-补 ① 起跑认定（RUNNING 字面一律立记录）', () => {
    const text = [
      'RUNNING GATE#10 by A',
      'RUNNING GATE#11 by B（已核 PM-LOG：GATE#10 于 08:17 收口绿）', // 行内先闭上一发再开
      '## END GATE#11 by B 18:17', // markdown 标题形态
      'RUNNING GATE#12 by C',
      '上面 09:20 那条 RUNNING GATE#12 到此闭合。', // 叙述闭合
      '我 grep `RUNNING GATE#39 …` 就自行配对', // 首见判据引用 ⇒ ⑧-补 ①：立记录（可见性优先于沉默）
      'GATE#39 那行本身是叙述内引、非起跑行',
    ].join('\n');
    const { records } = parseGateLocks(text);
    const byN = new Map(records.map((r) => [r.n, r]));
    expect(byN.get(10)?.status).toBe('closed');
    expect(byN.get(10)?.form).toBe('GATE#n 收口');
    expect(byN.get(11)?.status).toBe('closed');
    expect(byN.get(11)?.form).toBe('END GATE#n');
    expect(byN.get(12)?.status).toBe('closed');
    expect(byN.get(12)?.form).toBe('叙述闭合');
    expect(byN.get(39)?.status).toBe('open'); // RUNNING 字面在场 ⇒ 算起跑过（⑧-补 ①）
  });

  it('3. 真 open：RUNNING 无任何收口 ⇒ open；无号 GATE_EXIT= 收 30 行内最近 open', () => {
    const text = ['RUNNING GATE#20 by A', 'RUNNING GATE#21 by B', 'GATE_EXIT=0 @ now'].join('\n');
    const { records } = parseGateLocks(text);
    const open = records.filter((r) => r.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]?.n).toBe(20); // GATE_EXIT= 收了最近一枚（21），20 仍 open
    expect(open[0]?.startLine).toBe(1);
  });

  it('4. 不带值 GATE_EXIT=（判据引用形态）不收口；RUNNING 块内自引 GATE_EXIT= 误收＝文档化边界（行号留证）', () => {
    const text = [
      '判据原文：GATE_EXIT= 不带号这种形态也要认',
      'RUNNING GATE#30 by A',
      '本闸 GATE_EXIT=0 才算绿（预告，非收口）', // 启发式已知边界：会误收，输出带行号供人工核
    ].join('\n');
    const { records } = parseGateLocks(text);
    const r30 = records.find((r) => r.n === 30);
    expect(r30?.status).toBe('closed');
    expect(r30?.form).toBe('GATE_EXIT=');
    expect(r30?.endLine).toBe(3); // 行号在，人工一秒可核
  });

  it('5. 作废/ABORTED ⇒ closed-aborted；否定引用落 reference-only；规则引用首见 ⇒ open；远距「那条」不误判', () => {
    const text = [
      'RUNNING GATE#40 by A',
      'RUNNING GATE#41 by B（#40 作废）',
      'RUNNING GATE#42 by C',
      '换手：#43 于 17:22 ABORTED，重跑如下',
      'RUNNING GATE#44 by D',
      '闸进程 0、无 RUNNING GATE#45（否定引用：该行自报这枚没起跑）',
    ].join('\n');
    const { records, referenceOnly } = parseGateLocks(text);
    const byN = new Map(records.map((r) => [r.n, r]));
    expect(byN.get(40)?.status).toBe('closed-aborted');
    expect(byN.get(40)?.form).toBe('GATE#n 作废/中止');
    expect(byN.get(41)?.status).toBe('open');
    expect(byN.get(42)?.status).toBe('open'); // ABORTED 指向 #43（未开）⇒ 不动 #42
    expect(byN.get(44)?.status).toBe('open');
    expect(byN.has(45)).toBe(false); // 否定引用不立记录
    expect(referenceOnly).toContain(45);
    // 远距「那条」：真起跑行内引（#64 实例）不许被判成叙述闭合
    const long = [
      'RUNNING GATE#47 by E',
      'R-1 负控（摘 Move-Item 那行必红）必须入库后做——这条判据与本闸无关，' + 'x'.repeat(60),
    ].join('\n');
    const r2 = parseGateLocks(long);
    expect(r2.records.find((r) => r.n === 47)?.status).toBe('open');
  });

  it('6. ⑧-补 ③ 两枚真实行形态夹具：#96 L2636 形态（前导叙述＋真 RUNNING）closed 带行号；#99 L3306+L3318 形态（补记 RUNNING＋号段作废）closed-aborted 带行号', () => {
    // #96 L2636 实样形态：前导是叙述、RUNNING 字面在行中——⑧-补 ① 后必须立记录并收口，
    // 不许降成 reference-only（「这号段从没跑过」＝漏报 open 同族）
    const t96 = [
      '12:01 **私聊PM｜群PM 11:31「两批可入库」已执行。RUNNING GATE#96（发布批含 db8dc64 两批修复）**，起跑 12:01',
      '（中间叙述若干行）',
      '12:2x **群PM｜GATE#96 绿收口。** GATE_EXIT=0／880.3s',
    ].join('\n');
    const r96 = parseGateLocks(t96);
    const g96 = r96.records.find((r) => r.n === 96);
    expect(g96?.status).toBe('closed');
    expect(g96?.startLine).toBe(1);
    expect(g96?.endLine).toBe(3);
    expect(r96.referenceOnly).not.toContain(96);
    // #99 L3306+L3318 实样形态（⑧-补2 照原文重造）：「补记 RUNNING」无号、仓号 GATE#99 在
    // 行内深处（真实行 idx_RUNNING=16／idx_GATE#99=705，隔 689 字符取证正文）——
    // 救它的「补记 RUNNING＋行内带仓号」分支必须有锁：摘掉分支 ⇒ #99 落 reference-only ⇒ 本枚红
    const t99 = [
      '05:57 **私聊PM｜补记 RUNNING（起闸方未落行，我代为登记，防另一方再起一发撞车）**：看门狗 05:55 巡检发现全量闸在跑——`logs/gate-progress.log` 原文 `=== gate START @ 2026-11-14T21:51:32.062Z pid=30452 ===`（本地 05:51:32），号段登记为 GATE#99，闸窗内全组冻结',
      '（中间叙述若干行）',
      '06:03 **私聊PM｜收口 L3306 我那两条：号段 **GATE#99 作废**（未成一发，不作任何判据），并纠正我自己的归因。**',
    ].join('\n');
    const r99 = parseGateLocks(t99);
    const g99 = r99.records.find((r) => r.n === 99);
    expect(g99?.status).toBe('closed-aborted');
    expect(g99?.startLine).toBe(1);
    expect(g99?.endLine).toBe(3);
    expect(g99?.form).toBe('GATE#n 作废/中止');
    expect(r99.referenceOnly).not.toContain(99);
  });

  it('7. scanGateProcesses：本机返回数组且元素带 pid/cmd；非 win32 返回空', () => {
    const procs = scanGateProcesses();
    expect(Array.isArray(procs)).toBe(true);
    for (const p of procs) {
      expect(Number.isFinite(p.pid)).toBe(true);
      expect(typeof p.cmd).toBe('string');
      expect(/gate|vitest/i.test(p.cmd)).toBe(true);
    }
  });
});

describe('pmlog-locks · 真实仓现跑（期望值现算）＋N/A 面＋只读证明', () => {
  // ⑧-补3（群PM 判据）：CI 干净 checkout 没有台账时这两枚必须显式 skipped——
  // 「if (!exists) return」会让 vitest 记成 passed，"没判"伪装成"判过了"＝缺失≠干净 反面。
  const itRealLog = existsSync(REAL_PMLOG) ? it : it.skip;
  itRealLog('8. 真实 PM-LOG：三态自洽、reference-only 与 records 不重叠、Chief 验收锚（#23 aborted／#27 closed）', () => {
    const text = readFileSync(REAL_PMLOG, 'utf8');
    const { records, referenceOnly } = parseGateLocks(text);
    const open = records.filter((r) => r.status === 'open').length;
    const closed = records.filter((r) => r.status === 'closed').length;
    const aborted = records.filter((r) => r.status === 'closed-aborted').length;
    expect(open + closed + aborted).toBe(records.length);
    // 现算期望：台账里「running gate#n」起跑行总数（大小写不敏感——11-07 私聊PM 时代是小写 gate#n）
    const runningLines = text.split(/\r?\n/).filter((l) => /running\s+gate#\d+/i.test(l)).length;
    expect(records.length).toBeLessThanOrEqual(runningLines); // 否定引用行不开记录
    const openedNs = new Set(records.map((r) => r.n));
    for (const n of referenceOnly) expect(openedNs.has(n)).toBe(false);
    // Chief 验收锚（历史行，append-only 恒定）：#23＝FREE gate#23（中止，非收口）⇒ aborted；
    // #27＝END gate#27 ⇒ closed
    const byN = new Map(records.map((r) => [r.n, r]));
    expect(byN.get(23)?.status).toBe('closed-aborted');
    expect(byN.get(27)?.status).toBe('closed');
  });

  // ⑧-补3 移开跑读数抓到的同族第三格：枚 9 前半断言汇总行，台账缺席时必红——
  // 拆成 9a（itRealLog，台账在位才跑）＋9b（N/A 面恒跑），两态都不伪装
  itRealLog('9. CLI 真实仓：exit 0＋汇总行（台账在位）', () => {
    const r = execSync('npx tsx tools/gate/pmlog-locks.ts', {
      cwd: REAL_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(r).toContain('[pmlog-locks] 汇总：');
  });

  it('9b. CLI N/A 面：--pmlog 指不存在文件 ⇒ N/A exit 0（缺失≠干净）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pmloglocks-'));
    try {
      const missing = join(tmp, 'no-such-PM-LOG.md');
      let out = '';
      let code = 0;
      try {
        out = execSync(`npx tsx tools/gate/pmlog-locks.ts --pmlog "${missing}"`, {
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
  itRealLog('10. 只读证明：真实台账跑一遍工具，字节前后全等（含 mtime）', () => {
    const before = readFileSync(REAL_PMLOG);
    const beforeM = statSync(REAL_PMLOG).mtimeMs;
    execSync('npx tsx tools/gate/pmlog-locks.ts', {
      cwd: REAL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const after = readFileSync(REAL_PMLOG);
    const afterM = statSync(REAL_PMLOG).mtimeMs;
    expect(Buffer.compare(before, after)).toBe(0);
    expect(afterM).toBe(beforeM);
  });
});
