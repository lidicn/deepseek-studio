/**
 * FileReportStore（v0.30 SubBotReport 数据层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 ReportStore / SubBotReport / Finding（Claude 已锁定）。
 * 与 Claude 的测试桩 InMemoryReportStore 签名/返回语义完全一致，仅把存储从内存 Map 换成
 * 真实文件系统——Claude 在 desktop-host.ts 一行 `new InMemoryReportStore()` → `new FileReportStore(runsDir)`
 * 即可上线，无需改任何调用方（offline-runner / report-merge 都经 ReportStore 接口消费）。
 *
 * 落盘布局（设计稿 设计稿-Bot编排-账号槽位人设三层解耦-20261014.md:161：FS，不进 SQLite）：
 *   <runsDir>/
 *   └── <batchId>/                       # 一批审计（Claude 生成 batch-<base36>-<rand>，当不透明字符串）
 *       ├── <slotId>.jsonl               # 逐事件转录（appendFileSync 逐行追加，非单 JSON 数组）
 *       ├── <slotId>.report.json         # 结构化子报告（原子写：.tmp + rename，防读到半截）
 *       └── summary.md                   # 综合报告（report-merge 产物）
 *
 * base dir 解析与 memory-store.ts:61 / persona-registry.ts:26 一致：
 *   STUDIO_CONFIG_DIR 环境变量 > ~/.config/deepseek-studio，再拼 /runs。
 *
 * 全部同步 API（mkdirSync/appendFileSync/writeFileSync/renameSync/readdirSync/readFileSync/existsSync）：
 * ReportStore 接口方法均为同步签名（返回 string/void，非 Promise）；单进程 Node 宿主下同步写安全。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReportStore, SubBotReport } from './types';

/** 默认 runs 目录：<configDir>/runs。configDir 口径对齐 memory-store / persona-registry。 */
export function defaultRunsDir(): string {
  const configDir =
    process.env.STUDIO_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'deepseek-studio');
  return path.join(configDir, 'runs');
}

/**
 * 路径段安全校验：拒绝空串、`..`、含 `/` `\` 的 batchId / slotId，
 * 防越出 runsDir（batchId 由 Claude 生成，仍防御性校验，避免畸形输入写穿目录）。
 */
function assertSafeSegment(name: string, label: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`FileReportStore: illegal ${label}: ${JSON.stringify(name)}`);
  }
  return name;
}

export class FileReportStore implements ReportStore {
  private readonly runsDir: string;

  /** @param runsDir 批次根目录；缺省 = <configDir>/runs（生产由 Claude 传入，测试传 tmp 隔离）。 */
  constructor(runsDir?: string) {
    this.runsDir = runsDir && runsDir.length > 0 ? runsDir : defaultRunsDir();
  }

  /** mkdir -p <runsDir>/<batchId>，返回该批次目录绝对路径。 */
  ensureBatchDir(batchId: string): string {
    const dir = path.join(this.runsDir, assertSafeSegment(batchId, 'batchId'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 追加一行 jsonl 到 <runsDir>/<batchId>/<slotId>.jsonl。 */
  appendTranscript(batchId: string, slotId: string, event: unknown): void {
    const dir = this.ensureBatchDir(batchId);
    const file = path.join(dir, `${assertSafeSegment(slotId, 'slotId')}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  }

  /** 原子写 <runsDir>/<batchId>/<slotId>.report.json（写 .tmp + rename，防半截读）。 */
  writeSubReport(batchId: string, slotId: string, report: SubBotReport): void {
    const dir = this.ensureBatchDir(batchId);
    const target = path.join(dir, `${assertSafeSegment(slotId, 'slotId')}.report.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, target);
  }

  /** 读该批次所有 *.report.json → SubBotReport[]。批次不存在返 []；坏文件跳过并告警（不抛，不阻塞 merge）。 */
  readSubReports(batchId: string): SubBotReport[] {
    const dir = path.join(this.runsDir, assertSafeSegment(batchId, 'batchId'));
    if (!fs.existsSync(dir)) return [];
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: SubBotReport[] = [];
    // 按文件名排序：保证 merge 去重（首次出现者胜）/稳定排序的确定性（readdir 顺序随 FS）。
    for (const f of files.filter((n) => n.endsWith('.report.json')).sort()) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        out.push(JSON.parse(raw) as SubBotReport);
      } catch (err) {
        console.warn(`[report-store] skip unreadable report ${path.join(dir, f)}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** 写 <runsDir>/<batchId>/summary.md，返回绝对路径。 */
  writeMergedReport(batchId: string, content: string): string {
    const dir = this.ensureBatchDir(batchId);
    const file = path.join(dir, 'summary.md');
    fs.writeFileSync(file, content);
    return file;
  }

  /** 返回 summary.md 绝对路径；不存在返 ''。 */
  getMergedReportPath(batchId: string): string {
    const file = path.join(this.runsDir, assertSafeSegment(batchId, 'batchId'), 'summary.md');
    return fs.existsSync(file) ? file : '';
  }
}
