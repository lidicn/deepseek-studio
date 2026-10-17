/**
 * 真机验收共享客户端（M3 席5 专用）
 *
 * 独立 tsx 进程无法直接持有运行中宿主的 WebEngine。本模块通过宿主对外暴露的
 * HTTP API（POST /v1/tools/execute，Bearer 鉴权）把 tool 调用转发到已登录的
 * DeepSeek 页面，从而用真 WebEngine 驱动真机：
 *
 *   httpDispatch(tool, params)  ──HTTP──▶  宿主 invokeTool  ──ws──▶  已连接页 DOM
 *
 * 这正是 desktop-host 内部 createWebEngine({ dispatch }) 的 dispatch，只是走了一圈
 * 本机 HTTP，让验收脚本可以独立进程跑，不侵入运行时。
 *
 * 注意：chat-insert / chat-send 首次会在页面弹同意框，用户点「允许本次会话」后，
 * 后续同进程内调用静默放行（宿主 singleton sessionAllowlist）。
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecuteResult } from '../../../src/capabilities/types';
import { createWebEngine, type WebEngine } from '../../../src/host/engine/web-engine';

export interface LiveConfig {
  baseUrl: string;
  token: string;
}

/** 从 ~/.config/deepseek-studio/config.json 读 host/port/token（与运行中宿主同一份）。 */
export function loadLiveConfig(): LiveConfig {
  const cfgPath = process.env.STUDIO_CONFIG_PATH
    ? process.env.STUDIO_CONFIG_PATH
    : path.join(os.homedir(), '.config', 'deepseek-studio', 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`读不到宿主配置 ${cfgPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const host = String(process.env.DEEPSEEK_STUDIO_HOST ?? raw.host ?? '127.0.0.1');
  const port = Number(process.env.DEEPSEEK_STUDIO_PORT ?? raw.port ?? 8760);
  const token = String(process.env.DEEPSEEK_STUDIO_TOKEN ?? raw.token ?? '');
  if (!token) throw new Error(`配置里没有 token（${cfgPath}）`);
  return { baseUrl: `http://${host}:${port}`, token };
}

/** 跑一次 /healthz，不带鉴权。 */
export async function hostHealthz(cfg: LiveConfig): Promise<{ ok: boolean; body: string }> {
  try {
    const res = await fetch(`${cfg.baseUrl}/healthz`);
    const body = await res.text();
    return { ok: res.ok, body };
  } catch (e) {
    return { ok: false, body: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * WebEngine dispatch：把 chat-insert / chat-send / chat-read 经 HTTP 转发到真机页面。
 * 返回 ExecuteResult{ok,data,error}。
 */
export function makeHttpDispatch(cfg: LiveConfig) {
  return async function httpDispatch(tool: string, params: Record<string, unknown>): Promise<ExecuteResult> {
    const res = await fetch(`${cfg.baseUrl}/v1/tools/execute`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tool, params }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `bad-response(${res.status}): ${text.slice(0, 200)}` };
    }
    if (!res.ok) {
      return { ok: false, error: `http-${res.status}: ${text.slice(0, 200)}` };
    }
    return {
      ok: json.ok === true,
      data: (json.data as Record<string, unknown> | undefined) ?? undefined,
      error: (json.error as string | undefined) ?? undefined,
    };
  };
}

/** 构造一个连真机页面的 WebEngine。可选注入 onDelta / logger / onRoundComplete。 */
export function createLiveEngine(
  cfg: LiveConfig,
  hooks: {
    onDelta?: (text: string) => void;
    logger?: (entry: Record<string, unknown>) => void;
    onRoundComplete?: (entry: {
      round: number;
      content: string;
      toolCalls: number;
      completion: string;
      durationMs: number;
    }) => void;
    stepTimeoutMs?: number;
  } = {},
): WebEngine {
  return createWebEngine({
    dispatch: makeHttpDispatch(cfg),
    toolCallCounter: { current: 0 },
    onDelta: hooks.onDelta,
    logger: hooks.logger,
    onRoundComplete: hooks.onRoundComplete as never,
    ...(hooks.stepTimeoutMs ? { stepTimeoutMs: hooks.stepTimeoutMs } : {}),
  });
}

/**
 * 判断 chat-read 返回是不是「真页面」：
 * 页面在线时 data 形如 {count, messages:[...]}；无页面时宿主走 Node 兜底，
 * 返回的是 {snapshot:{...}}——这种情况要当成 health=false。
 */
export function isRealPageRead(r: ExecuteResult): boolean {
  if (!r.ok) return false;
  const data = r.data as { count?: number; messages?: unknown[] } | undefined;
  return !!data && Array.isArray(data.messages);
}
