// @vitest-environment node
/**
 * 2026-11-13 内核工具失败文案（与 `continuation-prompt` 同一类缺陷：`??` 兜不住空串）。
 *
 * 可达性证明（不是理论推演）：
 *   `real-tool-executor.ts:27` 是 `error: r.stderr ?? \`exit ${code}\`` ——
 *   命令**非零退出但 stderr 为空**（很常见：`exit 3` 什么都不打印）时 `error === ''`。
 *   `''` 不是 nullish ⇒ `task-loop.ts` 的 `rec.error ?? 'unknown error'` 与
 *   `tool-bridge.ts` 的 `r.error ?? 'unknown error'` 都**兜不住它**，
 *   模型侧最终看到的是 `[shell.exec] failed: `（冒号后面一片空白）。
 *
 * 两条口径（本文件锁死）：
 *   - **非空文案逐字节不变**（`[tool] failed: <原文>`），不借机改既有输出；
 *   - 其余（空串 / 纯空白 / `undefined` / `null`）→ 复用
 *     `shared/tool-result-format.failureTextFor`（自述工具名 ＋「请勿重复相同调用」），
 *     **不另写一套兜底文案**。`undefined` 的旧文案 `unknown error` 已按 2026-11-13 PM
 *     批的统一口径删除，`kernel-tool-bridge.test.ts #11` 同步**加强**改期望。
 *
 * 负控（见交卷）：把 `toolFailureDetail` 的空串分支改回 `'unknown error'`
 * ⇒ 第 2/3/4/5 组里所有「空串」用例红；逐字节还原后复绿。
 */
import { describe, expect, it } from 'vitest';

import { executeToolRecord, toolFailureDetail } from '../../src/host/kernel/tool-bridge';
import { createRealToolExecutor } from '../../src/host/kernel/real-tool-executor';
import { createHostToolsAdapter } from '../../src/host/kernel/host-tools-adapter';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import type { ModelEngine, EngineSendResult, ToolCallRecord } from '../../src/host/engine/model-engine';
import type { ExecutableCapability } from '../../src/capabilities/types';

function rec(tool: string): ToolCallRecord {
  return { tool, ok: true };
}

/** executor 直接返回给定结果（真实入口 executeToolRecord，不打私有 helper）。 */
function fixedExecutor(result: { ok: boolean; result?: string; error?: string }) {
  return { async execute() { return result; } };
}

describe('K-1 toolFailureDetail 口径表', () => {
  it('非空 → 原样（逐字节，不 trim 不改写）', () => {
    expect(toolFailureDetail('shell.exec', 'exit 1')).toBe('exit 1');
    expect(toolFailureDetail('shell.exec', '  spaced  ')).toBe('  spaced  ');
  });

  it('空串 / 纯空白 → 可读文本，且自述工具名', () => {
    for (const raw of ['', '   ', '\n\t']) {
      const text = toolFailureDetail('shell.exec', raw);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('shell.exec');
      expect(text).not.toBe('unknown error');
    }
  });

  it('undefined / null → 同一口径的可读文本（旧 unknown error 已删）', () => {
    for (const raw of [undefined, null]) {
      const text = toolFailureDetail('shell.exec', raw);
      expect(text).toContain('shell.exec');
      expect(text).not.toContain('unknown error');
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('K-2 tool-bridge.executeToolRecord：空串不再吞成空白', () => {
  it('stderr 为空串的失败 → content 冒号后不是空白，且 record.error 可读', async () => {
    const r = await executeToolRecord(fixedExecutor({ ok: false, error: '' }), rec('shell_exec'));

    expect(r.content.startsWith('[shell_exec] failed: ')).toBe(true);
    const detail = r.content.slice('[shell_exec] failed: '.length);
    expect(detail.trim().length).toBeGreaterThan(0);
    expect(detail).toContain('shell_exec');
    // record 也不许是「空串被当成没给」而丢字段
    expect(r.record.error && r.record.error.trim().length).toBeGreaterThan(0);
  });

  it('纯空白错误 → 同上（空白不算文案）', async () => {
    const r = await executeToolRecord(fixedExecutor({ ok: false, error: '   ' }), rec('shell_exec'));
    expect(r.content.slice('[shell_exec] failed: '.length).trim().length).toBeGreaterThan(0);
  });

  it('非空错误 → 逐字节不变', async () => {
    const r = await executeToolRecord(fixedExecutor({ ok: false, error: 'exit 1' }), rec('shell_exec'));
    expect(r.content).toBe('[shell_exec] failed: exit 1');
    expect(r.record.error).toBe('exit 1');
  });

  it('undefined 错误 → 同一口径的可读文本（含工具名、无 unknown error）', async () => {
    const r = await executeToolRecord(fixedExecutor({ ok: false }), rec('shell_exec'));
    expect(r.content.startsWith('[shell_exec] failed: ')).toBe(true);
    const detail = r.content.slice('[shell_exec] failed: '.length);
    expect(detail.trim().length).toBeGreaterThan(0);
    expect(detail).toContain('shell_exec');
    expect(detail).not.toContain('unknown error');
  });

  it('成功分支不受影响', async () => {
    const r = await executeToolRecord(fixedExecutor({ ok: true, result: 'a.txt' }), rec('shell_exec'));
    expect(r.content).toBe('[shell_exec] a.txt');
    expect(r.record.error).toBeUndefined();
  });
});

describe('K-3 真链路：非零退出 + 空 stderr（可达性本身）', () => {
  it('RealToolExecutor → ToolBridge：命令 exit 3 且无 stderr，模型侧不许是空白', async () => {
    const executor = createRealToolExecutor({
      shellExec: async () => ({ stdout: '', stderr: '', code: 3 }),
    });
    const r = await executeToolRecord(executor, rec('shell_exec'));

    expect(r.record.ok).toBe(false);
    const detail = r.content.slice('[shell_exec] failed: '.length);
    expect(detail.trim().length).toBeGreaterThan(0);
    expect(detail).toContain('shell_exec');
  });
});

describe('K-4 host-tools-adapter：同类 `?? unknown error`', () => {
  function cap(result: { ok: boolean; error?: string; data?: unknown }): ExecutableCapability {
    return {
      id: 'shell.exec',
      start: async () => {},
      stop: async () => {},
      execute: async () => result,
    } as unknown as ExecutableCapability;
  }

  it('能力返回空串 error → 可读文本（含工具名）', async () => {
    const adapter = createHostToolsAdapter(new Map([['shell.exec', cap({ ok: false, error: '' })]]));
    const r = await adapter.execute('shell.exec', {});
    expect(r.ok).toBe(false);
    expect(r.error && r.error.trim().length).toBeGreaterThan(0);
    expect(r.error).toContain('shell.exec');
  });

  it('能力返回非空 error → 逐字节不变', async () => {
    const adapter = createHostToolsAdapter(new Map([['shell.exec', cap({ ok: false, error: 'cwd-outside-workspace' })]]));
    const r = await adapter.execute('shell.exec', {});
    expect(r.error).toBe('cwd-outside-workspace');
  });

  it('能力没给 error → 同一口径可读文本（含工具名、无 unknown error）', async () => {
    const adapter = createHostToolsAdapter(new Map([['shell.exec', cap({ ok: false })]]));
    const r = await adapter.execute('shell.exec', {});
    expect(r.error && r.error.trim().length).toBeGreaterThan(0);
    expect(r.error).toContain('shell.exec');
    expect(r.error).not.toContain('unknown error');
  });
});

describe('K-5 task-loop 真实入口：role:tool 消息不许留空白原因', () => {
  function scriptedEngine(script: EngineSendResult[]): ModelEngine {
    let calls = 0;
    return {
      name: 'web',
      async send(): Promise<EngineSendResult> {
        const i = calls++;
        return script[Math.min(i, script.length - 1)];
      },
      health: async () => ({ ok: true }),
    };
  }

  it('工具记录 error 为空串 → 历史里的 tool 消息可读且含工具名', async () => {
    const records: ToolCallRecord[] = [{ tool: 'shell.exec', ok: false, error: '' }];
    const engine = scriptedEngine([
      { content: '跑命令', toolCalls: 1, toolCallRecords: records } as EngineSendResult,
      { content: '好了<task_complete>done</task_complete>', toolCalls: 0 } as EngineSendResult,
    ]);
    const history = createMessageHistory();
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    await loop.run('跑个命令');

    const toolMsg = history.all().find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const content = String(toolMsg!.content);
    expect(content.startsWith('[shell.exec] failed: ')).toBe(true);
    const detail = content.slice('[shell.exec] failed: '.length);
    expect(detail.trim().length).toBeGreaterThan(0);
    expect(detail).toContain('shell.exec');
  });

  it('工具记录 error 非空 → 逐字节不变', async () => {
    const engine = scriptedEngine([
      { content: '跑命令', toolCalls: 1, toolCallRecords: [{ tool: 'shell.exec', ok: false, error: 'exit 1' }] } as EngineSendResult,
      { content: '结束<task_complete>done</task_complete>', toolCalls: 0 } as EngineSendResult,
    ]);
    const history = createMessageHistory();
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    await loop.run('跑个命令');

    const toolMsg = history.all().find((m) => m.role === 'tool');
    expect(String(toolMsg!.content)).toBe('[shell.exec] failed: exit 1');
  });
});
