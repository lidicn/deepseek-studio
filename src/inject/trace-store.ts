/**
 * trace-store.ts — 执行追踪存储（移植自 deepseek++ trace-store.ts + trace-codec.ts）
 * @upstream-commit 187f6227 @upstream-path core/inline-agent/trace-store.ts
 *
 * 功能：
 * - 记录每次代理运行的步骤、工具调用、耗时
 * - 持久化到 localStorage
 * - 支持恢复历史追踪
 */

export interface TraceToolExecution {
  name: string;
  params: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface TraceStep {
  index: number;
  text: string;
  reasoning?: string;
  toolExecutions: TraceToolExecution[];
  collapsed: boolean;
}

export interface TraceRecord {
  id: string;
  chatSessionId: string;
  url: string;
  originalPrompt: string;
  status: 'running' | 'complete' | 'error';
  steps: TraceStep[];
  totalSteps: number;
  totalTools: number;
  finalText?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'ds-studio-traces';
const MAX_TRACES = 50;

/** 获取所有历史追踪 */
export function getAllTraces(): TraceRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 保存追踪记录 */
export function saveTrace(trace: TraceRecord): void {
  const traces = getAllTraces();
  const existingIdx = traces.findIndex((t) => t.id === trace.id);
  if (existingIdx >= 0) {
    traces[existingIdx] = trace;
  } else {
    traces.unshift(trace);
  }
  // 限制最大数量
  while (traces.length > MAX_TRACES) traces.pop();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(traces));
  } catch {
    // 存储满了，忽略
  }
}

/** 按 ID 获取追踪记录 */
export function getTrace(id: string): TraceRecord | null {
  return getAllTraces().find((t) => t.id === id) ?? null;
}

/** 删除追踪记录 */
export function deleteTrace(id: string): void {
  const traces = getAllTraces().filter((t) => t.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(traces));
  } catch {
    // 忽略
  }
}

/** 创建新追踪记录 */
export function createTrace(chatSessionId: string, originalPrompt: string): TraceRecord {
  const now = Date.now();
  return {
    id: `trace-${now}-${Math.random().toString(36).slice(2, 8)}`,
    chatSessionId,
    url: window.location.href,
    originalPrompt,
    status: 'running',
    steps: [],
    totalSteps: 0,
    totalTools: 0,
    createdAt: now,
    updatedAt: now,
  };
}
