/**
 * token-cost —— 本地、纯函数、离线的 token 估算 + cost 累计（ORD-005）
 *
 * - estimateTokens：粗略估算口径（CJK 约 1 字 1 token，拉丁约 4 字符 1 token），供 WebEngine 类无 usage 回包时估算。
 * - addUsage：按 ApiEngine 风格的 usage 字段累加 token 与 cost（USD）。
 * - 累计可加、可重置（zeroCost）；空输入不崩。
 *
 * 错误码见 CONTRACTS §6.1；失败一律 { ok:false, error }。
 */

import type { ExecuteResult } from './types';

export interface CostState {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageV1 {
  promptTokens?: number;
  completionTokens?: number;
}

export interface PricePer1k {
  prompt?: number; // USD per 1k prompt tokens
  completion?: number; // USD per 1k completion tokens
}

export interface TrackUsageInput {
  state?: CostState; // 缺省从零开始
  usage?: UsageV1;
  text?: string; // 给定时先用 estimateTokens 估算为 promptTokens 计入
  pricePer1k?: PricePer1k;
  reset?: boolean; // true → 先清零再累计
}

function ok(data: unknown): ExecuteResult {
  return { ok: true, data };
}
function fail(error: string): ExecuteResult {
  return { ok: false, error };
}

/** 粗估 token 数：CJK 字符按 1，其余按 4 字符 ≈ 1 token。空串返回 0。 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function zeroCost(): CostState {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export function addUsage(
  state: CostState,
  usage: UsageV1 | undefined,
  pricePer1k?: PricePer1k,
): CostState {
  const prompt = num(usage?.promptTokens);
  const completion = num(usage?.completionTokens);
  const pPrice = num(pricePer1k?.prompt);
  const cPrice = num(pricePer1k?.completion);
  const cost = (prompt / 1000) * pPrice + (completion / 1000) * cPrice;
  return {
    promptTokens: state.promptTokens + prompt,
    completionTokens: state.completionTokens + completion,
    totalTokens: state.totalTokens + prompt + completion,
    costUsd: Math.round((state.costUsd + cost) * 1e6) / 1e6,
  };
}

export async function trackUsage(input: TrackUsageInput): Promise<ExecuteResult> {
  if (input === null || typeof input !== 'object') {
    return fail('invalid-argument');
  }
  let state = input.reset ? zeroCost() : input.state ? { ...input.state } : zeroCost();

  if (typeof input.text === 'string' && input.text.length > 0) {
    state = addUsage(state, { promptTokens: estimateTokens(input.text) }, input.pricePer1k);
  }
  if (input.usage) {
    state = addUsage(state, input.usage, input.pricePer1k);
  }

  return ok(state);
}
