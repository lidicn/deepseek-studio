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
  stripComments,
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

  it('6b. send 丢 text 首参（只剩 signal）→ 被抓出（「text 参数存在」约束）', () => {
    const tampered = modelEngineSrc.replace(
      /send\(text: string, signal\?: AbortSignal\)/,
      'send(signal?: AbortSignal)',
    );
    const violations = checkModelEngine(tampered);
    expect(violations.some((v) => v.message.includes('send(text: string)'))).toBe(true);
  });

  it('6c. send 的 signal 改必填（去掉 ?）→ 被抓出（「signal 可选」约束、additive）', () => {
    const tampered = modelEngineSrc.replace(
      /send\(text: string, signal\?: AbortSignal\)/,
      'send(text: string, signal: AbortSignal)',
    );
    const violations = checkModelEngine(tampered);
    expect(violations.some((v) => v.message.includes('必填'))).toBe(true);
  });

  it('6d. waitForNextReply 的 signal 改必填 → 被抓出（N2-04 同步、防同坑再踩）', () => {
    const tampered = modelEngineSrc.replace(
      /waitForNextReply\?\(signal\?: AbortSignal\)/,
      'waitForNextReply?(signal: AbortSignal)',
    );
    const violations = checkModelEngine(tampered);
    expect(violations.some((v) => v.message.includes('waitForNextReply'))).toBe(true);
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

describe('契约守门 · 注释剥离（20261101 F6 假阳性防护）', () => {
  it('12. union 内部 JSDoc 里的字面量不算合法/非法值', () => {
    // 复刻 20261101 事故形态：TaskLoopStopReason union body 内部的 JSDoc 含白名单外字面量
    const tampered = taskLoopSrc.replace(
      /\| 'timeout'/,
      "/** 说明：completion='disconnected'，reason='bogus-in-comment' */\n  | 'timeout'",
    );
    const violations = checkTaskLoop(tampered);
    expect(violations.some((v) => v.message.includes('disconnected'))).toBe(false);
    expect(violations.some((v) => v.message.includes('bogus-in-comment'))).toBe(false);
    expect(violations).toEqual([]);
  });

  it('13. 负控：真实代码里的非法值仍被抓出（剥注释不得掩盖真违规）', () => {
    const tampered = taskLoopSrc.replace(
      /\| 'max-rounds'/,
      "| 'max-rounds' | 'bogus-in-code'",
    );
    const violations = checkTaskLoop(tampered);
    expect(violations.some((v) => v.message.includes('bogus-in-code'))).toBe(true);
  });

  it('14. read-no-data 已入合法值清单（F6 语义：页在但读不到）', () => {
    // 真实源码含 read-no-data 成员，不应再报非法值
    const violations = checkTaskLoop(taskLoopSrc);
    expect(violations.some((v) => v.message.includes('read-no-data'))).toBe(false);
    expect(violations).toEqual([]);
  });

  it('14b. interrupted 已入合法值清单（M1 语义：流过完但无完成哨兵、本轮有可见输出）', () => {
    // 真实源码含 interrupted 成员（M1），不应再报非法值；负控见 14c
    const violations = checkTaskLoop(taskLoopSrc);
    expect(violations.some((v) => v.message.includes('interrupted'))).toBe(false);
    expect(violations).toEqual([]);
  });

  it('14c. 负控：清单外的假值（bogus-term）仍被拒——守门只准因设计变更扩清单，不准变成什么都放', () => {
    const tampered = taskLoopSrc.replace(
      /\| 'aborted'/,
      "| 'aborted' | 'bogus-term'",
    );
    const violations = checkTaskLoop(tampered);
    expect(violations.some((v) => v.message.includes("非法值 'bogus-term'"))).toBe(true);
  });

  it('15. stripComments：注释移除，字符串/正则/模板字面量原样保留', () => {
    const s = [
      "const a = 'keep1'; // 'drop-line'",
      "/* 'drop-block' */ const b = /'in-regex'/;",
      'const c = `tpl`;',
    ].join('\n');
    const out = stripComments(s);
    expect(out).toContain("'keep1'");
    expect(out).toContain("/'in-regex'/");
    expect(out).toContain('`tpl`');
    expect(out).not.toContain('drop-line');
    expect(out).not.toContain('drop-block');
  });
});
