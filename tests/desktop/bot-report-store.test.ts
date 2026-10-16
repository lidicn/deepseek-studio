/**
 * FileReportStore 单测（v0.30 SubBotReport 数据层 · 副开发 CodeBuddy）
 *
 * 契约：src/host/bot/types.ts 的 ReportStore（Claude 已锁定，6 个同步方法）。
 * 覆盖路线图 §2.4 全部门槛：
 *   1) ensureBatchDir 建目录并返回绝对路径（幂等）
 *   2) appendTranscript 逐行 jsonl 追加、顺序保真、每行独立可 JSON.parse
 *   3) writeSubReport → readSubReports 往返一致（含 findings/evidenceRefs/transcriptPath）
 *   4) 多槽按文件名排序读回（确定性）
 *   5) 批次不存在 → []
 *   6) writeMergedReport / getMergedReportPath 写查一致；未写 → ''
 *   7) 原子写：写完即完整、无 .tmp 残留
 *   8) 缺省 runsDir = <STUDIO_CONFIG_DIR 或 ~/.config/deepseek-studio>/runs
 *   9) 路径穿越拒绝：batchId/slotId 含 `..` `/` `\` 或空串一律抛错
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileReportStore, defaultRunsDir } from '../../src/host/bot/report-store';
import type { SubBotReport } from '../../src/host/bot/types';

const tmpRoot = path.join(os.tmpdir(), `studio-report-store-test-${Date.now()}`);
let runsDir: string;
let store: FileReportStore;

function mkReport(slotId: string, overrides: Partial<SubBotReport> = {}): SubBotReport {
  return {
    slotId,
    dimension: slotId,
    summary: `${slotId} 维度的审计摘要`,
    findings: [
      {
        id: `${slotId}-F1`,
        severity: 'high',
        title: `${slotId} 发现的问题`,
        location: 'src/a.ts',
        description: '具体描述',
        evidenceRef: 'src/a.ts:10',
      },
    ],
    evidenceRefs: ['src/a.ts:10'],
    transcriptPath: `runs/batch-1/${slotId}.jsonl`,
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  runsDir = path.join(tmpRoot, 'runs');
  store = new FileReportStore(runsDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('FileReportStore · 目录与路径', () => {
  it('ensureBatchDir 创建批次目录并返回绝对路径', () => {
    const dir = store.ensureBatchDir('batch-abc');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.join(runsDir, 'batch-abc'));
  });

  it('ensureBatchDir 幂等：重复调用不报错、返回同一路径', () => {
    const a = store.ensureBatchDir('batch-abc');
    const b = store.ensureBatchDir('batch-abc');
    expect(a).toBe(b);
    expect(fs.existsSync(a)).toBe(true);
  });

  it('批次不存在时 readSubReports 返回 []（不抛）', () => {
    expect(store.readSubReports('batch-never-created')).toEqual([]);
  });

  it('目录缺失时 getMergedReportPath 返回空串', () => {
    expect(store.getMergedReportPath('batch-never-created')).toBe('');
  });
});

describe('FileReportStore · 转录 jsonl', () => {
  it('appendTranscript 逐行追加：顺序保真、每行可独立解析', () => {
    store.appendTranscript('batch-1', 'slot-a', { ts: 1, text: '第一条' });
    store.appendTranscript('batch-1', 'slot-a', { ts: 2, text: '第二条' });
    store.appendTranscript('batch-1', 'slot-a', { ts: 3, text: '第三条' });

    const file = path.join(runsDir, 'batch-1', 'slot-a.jsonl');
    expect(fs.existsSync(file)).toBe(true);

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { ts: 1, text: '第一条' },
      { ts: 2, text: '第二条' },
      { ts: 3, text: '第三条' },
    ]);
  });

  it('不同槽各写各的 jsonl 文件（互不覆盖）', () => {
    store.appendTranscript('batch-1', 'security', { kind: 'evt' });
    store.appendTranscript('batch-1', 'performance', { kind: 'evt' });

    const dir = path.join(runsDir, 'batch-1');
    expect(fs.existsSync(path.join(dir, 'security.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'performance.jsonl'))).toBe(true);
  });

  it('批次目录未预建时 appendTranscript 自兜底建目录', () => {
    store.appendTranscript('batch-lazy', 'slot-a', { ok: true });
    expect(fs.existsSync(path.join(runsDir, 'batch-lazy', 'slot-a.jsonl'))).toBe(true);
  });

  it('单行 JSON 事件含嵌套对象/中文可往返', () => {
    const ev = { role: 'assistant', content: '发现一处越界「${x}」', meta: { nested: { a: [1, 2] } } };
    store.appendTranscript('batch-1', 'slot-a', ev);
    const line = fs.readFileSync(path.join(runsDir, 'batch-1', 'slot-a.jsonl'), 'utf8').trim();
    expect(JSON.parse(line)).toEqual(ev);
  });
});

describe('FileReportStore · 子报告读回', () => {
  it('writeSubReport → readSubReports 往返一致', () => {
    const report = mkReport('security');
    store.writeSubReport('batch-1', 'security', report);

    const got = store.readSubReports('batch-1');
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(report);
    expect(got[0].findings[0].severity).toBe('high');
    expect(got[0].evidenceRefs).toEqual(['src/a.ts:10']);
    expect(got[0].transcriptPath).toBe('runs/batch-1/security.jsonl');
  });

  it('同槽重复写：覆盖而非追加（原子写语义）', () => {
    store.writeSubReport('batch-1', 'security', mkReport('security', { summary: '初版' }));
    store.writeSubReport('batch-1', 'security', mkReport('security', { summary: '终版' }));

    const got = store.readSubReports('batch-1');
    expect(got).toHaveLength(1);
    expect(got[0].summary).toBe('终版');
  });

  it('多槽读回按文件名排序（确定性）', () => {
    store.writeSubReport('batch-1', 'performance', mkReport('performance'));
    store.writeSubReport('batch-1', 'maintainability', mkReport('maintainability'));
    store.writeSubReport('batch-1', 'security', mkReport('security'));

    const got = store.readSubReports('batch-1');
    expect(got.map((r) => r.slotId)).toEqual(['maintainability', 'performance', 'security']);
  });

  it('批次隔离：不同 batchId 互不串味', () => {
    store.writeSubReport('batch-A', 'security', mkReport('security', { summary: 'A 批' }));
    store.writeSubReport('batch-B', 'security', mkReport('security', { summary: 'B 批' }));

    expect(store.readSubReports('batch-A')[0].summary).toBe('A 批');
    expect(store.readSubReports('batch-B')[0].summary).toBe('B 批');
  });

  it('只读 *.report.json，不把 .jsonl / summary.md 混进来', () => {
    store.writeSubReport('batch-1', 'security', mkReport('security'));
    store.appendTranscript('batch-1', 'security', { kind: 'evt' });
    store.writeMergedReport('batch-1', '# 综合审计报告');

    const got = store.readSubReports('batch-1');
    expect(got).toHaveLength(1);
    expect(got[0].slotId).toBe('security');
  });

  it('空批次（目录存在但无报告）返回 []', () => {
    store.ensureBatchDir('batch-empty');
    expect(store.readSubReports('batch-empty')).toEqual([]);
  });

  it('坏 JSON 文件跳过不抛（不阻塞 merge）', () => {
    store.writeSubReport('batch-1', 'security', mkReport('security'));
    fs.writeFileSync(path.join(runsDir, 'batch-1', 'zz-broken.report.json'), '{ 不是合法 JSON', 'utf8');

    const got = store.readSubReports('batch-1');
    expect(got).toHaveLength(1);
    expect(got[0].slotId).toBe('security');
  });

  it('原子写：写完即完整、目录无 .tmp 残留', () => {
    store.writeSubReport('batch-1', 'security', mkReport('security'));
    const dir = path.join(runsDir, 'batch-1');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
    // 文件内容本身即完整可解析 JSON（不留半截）
    JSON.parse(fs.readFileSync(path.join(dir, 'security.report.json'), 'utf8'));
  });
});

describe('FileReportStore · 综合报告', () => {
  it('writeMergedReport 返回路径且内容一致', () => {
    const content = '# 综合审计报告\n\n## 发现列表\n- [high] A\n';
    const p = store.writeMergedReport('batch-1', content);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe(content);
    expect(path.basename(p)).toBe('summary.md');
  });

  it('getMergedReportPath 与写入路径一致', () => {
    const p = store.writeMergedReport('batch-1', 'x');
    expect(store.getMergedReportPath('batch-1')).toBe(p);
  });

  it('覆盖写 summary.md（不留旧内容）', () => {
    store.writeMergedReport('batch-1', '第一版内容'.repeat(50));
    const p = store.writeMergedReport('batch-1', '第二版');
    expect(fs.readFileSync(p, 'utf8')).toBe('第二版');
  });
});

describe('FileReportStore · 默认目录解析', () => {
  const savedEnv = process.env.STUDIO_CONFIG_DIR;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.STUDIO_CONFIG_DIR;
    else process.env.STUDIO_CONFIG_DIR = savedEnv;
  });

  it('STUDIO_CONFIG_DIR 存在 → <dir>/runs', () => {
    process.env.STUDIO_CONFIG_DIR = path.join(tmpRoot, 'cfg');
    expect(defaultRunsDir()).toBe(path.join(tmpRoot, 'cfg', 'runs'));
  });

  it('STUDIO_CONFIG_DIR 缺失 → ~/.config/deepseek-studio/runs', () => {
    delete process.env.STUDIO_CONFIG_DIR;
    expect(defaultRunsDir()).toBe(path.join(os.homedir(), '.config', 'deepseek-studio', 'runs'));
  });

  it('构造不传参时使用默认目录解析结果', () => {
    process.env.STUDIO_CONFIG_DIR = path.join(tmpRoot, 'cfg2');
    const s = new FileReportStore();
    s.writeSubReport('batch-default', 'security', mkReport('security'));
    expect(fs.existsSync(path.join(tmpRoot, 'cfg2', 'runs', 'batch-default', 'security.report.json'))).toBe(
      true,
    );
  });

  it('传入空串参数回落默认目录', () => {
    process.env.STUDIO_CONFIG_DIR = path.join(tmpRoot, 'cfg3');
    const s = new FileReportStore('');
    expect(s.ensureBatchDir('batch-x')).toBe(
      path.join(tmpRoot, 'cfg3', 'runs', 'batch-x'),
    );
  });
});

describe('FileReportStore · 路径穿越防护', () => {
  it('batchId 含 `..` 被拒绝（各写入口一致）', () => {
    expect(() => store.ensureBatchDir('..')).toThrow(/illegal batchId/);
    expect(() => store.ensureBatchDir('../escape')).toThrow(/illegal batchId/);
    expect(() => store.appendTranscript('../escape', 'slot', {})).toThrow(/illegal batchId/);
    expect(() => store.writeSubReport('../escape', 'slot', mkReport('slot'))).toThrow(/illegal batchId/);
    expect(() => store.readSubReports('../escape')).toThrow(/illegal batchId/);
    expect(() => store.writeMergedReport('../escape', 'x')).toThrow(/illegal batchId/);
    expect(() => store.getMergedReportPath('../escape')).toThrow(/illegal batchId/);
  });

  it('batchId 含分隔符被拒绝', () => {
    expect(() => store.ensureBatchDir('a/b')).toThrow(/illegal batchId/);
    expect(() => store.ensureBatchDir('a\\b')).toThrow(/illegal batchId/);
  });

  it('batchId 空串 / `.` 被拒绝', () => {
    expect(() => store.ensureBatchDir('')).toThrow(/illegal batchId/);
    expect(() => store.ensureBatchDir('.')).toThrow(/illegal batchId/);
  });

  it('slotId 含 `..` 或分隔符被拒绝', () => {
    expect(() => store.appendTranscript('batch-1', '../evil', {})).toThrow(/illegal slotId/);
    expect(() => store.writeSubReport('batch-1', '../evil', mkReport('evil'))).toThrow(/illegal slotId/);
    expect(() => store.appendTranscript('batch-1', 'sub/evil', {})).toThrow(/illegal slotId/);
    expect(() => store.appendTranscript('batch-1', '', {})).toThrow(/illegal slotId/);
  });

  it('拒绝后 runsDir 外不产生任何文件', () => {
    try {
      store.writeSubReport('../escape', 'slot', mkReport('slot'));
    } catch {
      /* 预期抛错 */
    }
    expect(fs.existsSync(path.join(tmpRoot, 'escape'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(runsDir), 'escape'))).toBe(false);
  });
});
