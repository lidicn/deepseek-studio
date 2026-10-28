/**
 * 装配守卫：desktop-host 的 agent 任务回合超时必须是 300s。
 *
 * 背景：一次 engine.send() 内含 WebEngine auto-continue 的整条工具链，
 * 真机多轮工具任务实测约 162s，TaskLoop 默认 120s 会把成功回合误判为 timeout。
 * 这里静态读源码，确保两处 createTaskLoop 装配点都显式传入 300s。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const hostSrc = readSrc('src/host/desktop-host.ts');

describe('desktop-host · agent 任务回合超时装配', () => {
  it('常量 AGENT_TASK_ROUND_TIMEOUT_MS 为 300_000', () => {
    expect(hostSrc).toMatch(
      /const\s+AGENT_TASK_ROUND_TIMEOUT_MS\s*=\s*300_000\s*;/,
    );
  });

  it('两处 createTaskLoop 都传入 roundTimeoutMs: AGENT_TASK_ROUND_TIMEOUT_MS', () => {
    const loopCalls = hostSrc.match(/createTaskLoop\s*\(\s*\{[\s\S]*?\}\s*\)/g) ?? [];
    expect(loopCalls.length).toBe(2);
    for (const call of loopCalls) {
      expect(call).toMatch(/roundTimeoutMs\s*:\s*AGENT_TASK_ROUND_TIMEOUT_MS/);
    }
  });

  it('反例：去掉 roundTimeoutMs 的装配会被抓出', () => {
    const tampered = hostSrc.replace(
      /roundTimeoutMs\s*:\s*AGENT_TASK_ROUND_TIMEOUT_MS\s*,?/g,
      '',
    );
    const loopCalls = tampered.match(/createTaskLoop\s*\(\s*\{[\s\S]*?\}\s*\)/g) ?? [];
    expect(loopCalls.length).toBe(2);
    for (const call of loopCalls) {
      expect(call).not.toMatch(/roundTimeoutMs/);
    }
  });
});
