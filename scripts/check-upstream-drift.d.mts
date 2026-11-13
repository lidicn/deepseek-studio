/**
 * scripts/check-upstream-drift.mjs 的类型声明（供 tests/desktop 的单测导入）。
 * 与 .mjs 的导出保持同步：改导出签名时两处一起改（scripts/ 不在 tsconfig include 内，
 * .mjs 本体不被 tsc 检查，本文件是测试侧的类型锚）。
 */

export interface DriftRegistryEntry {
  file: string;
  upstreamBlob16: string;
  localBlob16: string;
  verdictRef?: string;
}

export interface LoadedRegistry {
  ok: boolean;
  error: string | null;
  entries: Map<string, DriftRegistryEntry>;
  upstreamPath: string | null;
  updatedAt?: string | null;
}

export type DriftState = 'identical' | 'known' | 'stale' | 'new' | 'anchor';

export declare function loadRegistry(path?: string): LoadedRegistry;

export declare function resolveUpstreamDir(args: {
  cliArg?: string | null;
  envDir?: string | null;
  registry?: LoadedRegistry | null;
}): string | null;

export declare function classifyFile(args: {
  upstreamExists: boolean;
  anchorOk: boolean;
  identical: boolean;
  registered: boolean;
  localMatch: boolean;
  upstreamMatch: boolean;
}): DriftState;

export declare function hasBlockingFindings(args: {
  newDrift: number;
  stale: number;
  anchorIssues: number;
  deadPorts: number;
}): boolean;

export declare function formatSummaryLine(counts: {
  identical: number;
  known: number;
  stale: number;
  newDrift: number;
  anchorIssues: number;
  deadPorts: number;
}): string;
