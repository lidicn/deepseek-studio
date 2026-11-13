/**
 * scripts/check-upstream-drift.mjs 自身单测（2026-11-14 (a) 定性登记表卡，Gate 写域）。
 *
 * 只测纯函数（resolveUpstreamDir / classifyFile / hasBlockingFindings / formatSummaryLine /
 * loadRegistry 的文件行为），不触真实上游仓库、不发网络请求。
 * 真实 CLI 行为（负控三枚）由交卷时的命令行运行覆盖，见交卷读数。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRegistry,
  resolveUpstreamDir,
  classifyFile,
  hasBlockingFindings,
  formatSummaryLine,
} from '../../scripts/check-upstream-drift.mjs';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'drift-registry-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop() as string;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('loadRegistry', () => {
  it('合法登记表 → ok:true，entries 成 Map，upstreamPath/updatedAt 带出', () => {
    const d = tempDir();
    const p = join(d, 'registry.json');
    writeFileSync(
      p,
      JSON.stringify({
        updatedAt: '2026-11-14',
        upstreamPath: 'E:/NAS/deepseek-pp',
        entries: [{ file: 'src/a.ts', upstreamBlob16: 'aaaaaaaaaaaaaaaa', localBlob16: 'bbbbbbbbbbbbbbbb' }],
      }),
      'utf8',
    );
    const reg = loadRegistry(p);
    expect(reg.ok).toBe(true);
    expect(reg.upstreamPath).toBe('E:/NAS/deepseek-pp');
    expect(reg.updatedAt).toBe('2026-11-14');
    expect(reg.entries.get('src/a.ts')?.upstreamBlob16).toBe('aaaaaaaaaaaaaaaa');
  });

  it('登记表不存在 → ok:false（fail-closed，漂移按未登记处理）', () => {
    const reg = loadRegistry(join(tempDir(), 'nope.json'));
    expect(reg.ok).toBe(false);
    expect(reg.error).toBe('登记表不存在');
    expect(reg.entries.size).toBe(0);
    expect(reg.upstreamPath).toBe(null);
  });

  it('登记表损坏（非法 JSON）→ ok:false，不抛出', () => {
    const d = tempDir();
    const p = join(d, 'registry.json');
    writeFileSync(p, '{ not json', 'utf8');
    const reg = loadRegistry(p);
    expect(reg.ok).toBe(false);
    expect(reg.error).toContain('解析失败');
  });
});

describe('resolveUpstreamDir（真源优先级：--upstream > UPSTREAM_DIR > 登记表）', () => {
  const registry = { ok: true, error: null, entries: new Map(), upstreamPath: 'FROM_REGISTRY' };

  it('CLI 覆盖一切', () => {
    expect(resolveUpstreamDir({ cliArg: 'FROM_CLI', envDir: 'FROM_ENV', registry })).toBe('FROM_CLI');
  });
  it('env 次之', () => {
    expect(resolveUpstreamDir({ cliArg: null, envDir: 'FROM_ENV', registry })).toBe('FROM_ENV');
  });
  it('登记表是缺省真源', () => {
    expect(resolveUpstreamDir({ cliArg: null, envDir: null, registry })).toBe('FROM_REGISTRY');
  });
  it('三处皆无 → null（主流程据此报错退出）', () => {
    expect(resolveUpstreamDir({ cliArg: null, envDir: null, registry: { ok: true, error: null, entries: new Map(), upstreamPath: null } })).toBe(null);
  });
});

describe('classifyFile 三态判定（M/K/A/D 定义，不许放宽）', () => {
  const base = { upstreamExists: true, anchorOk: true, identical: false, registered: true, localMatch: true, upstreamMatch: true };

  it('上游不存在或锚点字段缺失 → anchor（FAIL）', () => {
    expect(classifyFile({ ...base, upstreamExists: false })).toBe('anchor');
    expect(classifyFile({ ...base, anchorOk: false })).toBe('anchor');
  });

  it('本地与上游逐字节一致 → identical（无漂移，绿）', () => {
    expect(classifyFile({ ...base, identical: true })).toBe('identical');
  });

  it('已登记且两侧 blob16 与登记值一致 → known（已知定性漂移，不报红）', () => {
    expect(classifyFile({ ...base, identical: false, registered: true, localMatch: true, upstreamMatch: true })).toBe('known');
  });

  it('已登记但任一侧 blob16 变了 → stale（定性过期，FAIL）', () => {
    expect(classifyFile({ ...base, identical: false, registered: true, localMatch: false, upstreamMatch: true })).toBe('stale');
    expect(classifyFile({ ...base, identical: false, registered: true, localMatch: true, upstreamMatch: false })).toBe('stale');
    expect(classifyFile({ ...base, identical: false, registered: true, localMatch: false, upstreamMatch: false })).toBe('stale');
  });

  it('漂移但未登记 → new（新增漂移，FAIL）', () => {
    expect(classifyFile({ ...base, identical: false, registered: false, localMatch: false, upstreamMatch: false })).toBe('new');
  });
});

describe('hasBlockingFindings（exit 码规则：M/K/A/D 任一 > 0 即阻塞）', () => {
  const zero = { newDrift: 0, stale: 0, anchorIssues: 0, deadPorts: 0 };

  it('全零 → false（已知定性漂移不阻塞）', () => {
    expect(hasBlockingFindings(zero)).toBe(false);
    expect(hasBlockingFindings({ ...zero, known: 5 } as never)).toBe(false);
  });

  it('任一项 > 0 → true', () => {
    expect(hasBlockingFindings({ ...zero, newDrift: 1 })).toBe(true);
    expect(hasBlockingFindings({ ...zero, stale: 1 })).toBe(true);
    expect(hasBlockingFindings({ ...zero, anchorIssues: 1 })).toBe(true);
    expect(hasBlockingFindings({ ...zero, deadPorts: 1 })).toBe(true);
  });
});

describe('formatSummaryLine（判据③ 固定格式）', () => {
  it('当前 5 枚已知定性漂移的读数行', () => {
    expect(
      formatSummaryLine({ identical: 0, known: 5, stale: 0, newDrift: 0, anchorIssues: 0, deadPorts: 0 }),
    ).toBe('一致: 0 | 已知定性漂移: 5 | 新增漂移: 0 | 定性过期: 0 | 锚点异常: 0 | 死移植: 0');
  });
  it('阻塞读数行（新增漂移/定性过期计数如实出现）', () => {
    expect(
      formatSummaryLine({ identical: 0, known: 4, stale: 1, newDrift: 1, anchorIssues: 0, deadPorts: 0 }),
    ).toBe('一致: 0 | 已知定性漂移: 4 | 新增漂移: 1 | 定性过期: 1 | 锚点异常: 0 | 死移植: 0');
  });
});
