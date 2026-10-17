/**
 * S2 契约守门测试：静态读源码断言 ModelEngine / MessageHistory / TaskLoop 契约。
 * 含正例（真实源码应通过）和反例（篡改源码应被抓出）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkModelEngine,
  checkMessageHistory,
  checkTaskLoop,
} from '../../tools/contract/check';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

// ---- 真实源码（正例）----

const modelEngineSrc = readSrc('src/host/engine/model-engine.ts');
const messageHistorySrc = readSrc('src/host/kernel/message-history.ts');
const taskLoopSrc = readSrc('src/host/kernel/task-loop.ts');

describe('契约守门 · 正例（真实源码应通过）', () => {
  it('1. model-engine.ts 无违规', () => {
    expect(checkModelEngine(modelEngineSrc)).toEqual([]);
  });

  it('2. message-history.ts 无违规', () => {
    expect(checkMessageHistory(messageHistorySrc)).toEqual([]);
  });

  it('3. task-loop.ts 无违规', () => {
    expect(checkTaskLoop(taskLoopSrc)).toEqual([]);
  });
});

describe('契约守门 · ModelEngine 反例', () => {
  it('4. toolCalls 被改成 ToolCallRecord[] → 被抓出', () => {
    const tampered = modelEngineSrc.replace(
      /readonly\s+toolCalls\s*:\s*number/,
      'readonly toolCalls: ToolCallRecord[]',
    );
    const violations = checkModelEngine(tampered);
    expect(violations.some((v) => v.message.includes('toolCalls') && v.message.includes('非 number'))).toBe(true);
  });

  it('5. toolCallRecords 被改成必填（去掉问号）→ 被抓出', () => {
    const tampered = modelEngineSrc.replace(
      /readonly\s+toolCallRecords\?\s*:/,
      'readonly toolCallRecords:',
    );
    const violations = checkModelEngine(tampered);
    expect(violations.some((v) => v.message.includes('必填'))).toBe(true);
  });

  it('6. 缺少 createApiEngineStub 导出 → 被抓出', () => {
    const tampered = modelEngineSrc.replace(/export\s+function\s+createApiEngineStub/, 'function createApiEngineStub');
    const violations = checkModelEngine(tampered);
    expect(violations.some((v) => v.message.includes('createApiEngineStub'))).toBe(true);
  });
});

describe('契约守门 · MessageHistory 反例', () => {
  it('7. MESSAGE_HISTORY_VERSION 改成 2 → 被抓出', () => {
    const tampered = messageHistorySrc.replace(
      /MESSAGE_HISTORY_VERSION\s*=\s*1\s+as\s+const/,
      'MESSAGE_HISTORY_VERSION = 2 as const',
    );
    const violations = checkMessageHistory(tampered);
    expect(violations.some((v) => v.message.includes('VERSION'))).toBe(true);
  });

  it('8. snapshot.version 改成字面量 2 → 被抓出', () => {
    const tampered = messageHistorySrc.replace(
      /readonly\s+version\s*:\s*1;/,
      'readonly version: 2;',
    );
    const violations = checkMessageHistory(tampered);
    expect(violations.some((v) => v.message.includes('version') && v.message.includes('1'))).toBe(true);
  });
});

describe('契约守门 · TaskLoop 反例', () => {
  it('9. TaskLoopStopReason 加了非法值 → 被抓出', () => {
    const tampered = taskLoopSrc.replace(
      /\| 'max-rounds'/,
      "| 'max-rounds' | 'bogus'",
    );
    const violations = checkTaskLoop(tampered);
    expect(violations.some((v) => v.message.includes('bogus'))).toBe(true);
  });

  it('10. TaskLoopStopReason 删掉 timeout → 被抓出', () => {
    const tampered = taskLoopSrc.replace(/\s*\|\s*'timeout'/, '');
    const violations = checkTaskLoop(tampered);
    expect(violations.some((v) => v.message.includes('timeout'))).toBe(true);
  });

  it('11. 缺少 createTaskLoop 导出 → 被抓出', () => {
    const tampered = taskLoopSrc.replace(/export\s+function\s+createTaskLoop/, 'function createTaskLoop');
    const violations = checkTaskLoop(tampered);
    expect(violations.some((v) => v.message.includes('createTaskLoop'))).toBe(true);
  });
});
