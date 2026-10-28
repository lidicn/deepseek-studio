import { describe, it, expect } from 'vitest';
import { StreamingToolCallParser } from '../../src/inject/streaming-tool-parser';

describe('StreamingToolCallParser - JSON 容错', () => {
  it('正常 JSON 解析', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<shell_exec>{"command":"echo hello"}</shell_exec>');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].params).toEqual({ command: 'echo hello' });
    expect(r.calls[0].params.__invalid_json).toBeUndefined();
  });

  it('未转义的字符串内引号应被自动修复', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    // 模拟模型输出的未转义 JSON：命令里有嵌套双引号但没转义
    const body = `{"command":"powershell -Command "Get-ChildItem""}`;
    const r = p.feed(`<shell_exec>${body}</shell_exec>`);
    expect(r.calls).toHaveLength(1);
    // 修复后应该能解析出 command，且不标记 __invalid_json
    expect(r.calls[0].params.__invalid_json).toBeUndefined();
    expect(typeof r.calls[0].params.command).toBe('string');
    expect(r.calls[0].params.command).toContain('powershell');
  });

  it('键名结束后的引号不应被误判为字符串内引号', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    // 正确的 JSON，不应该触发修复逻辑
    const r = p.feed('<shell_exec>{"command":"echo test"}</shell_exec>');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].params).toEqual({ command: 'echo test' });
  });

  // QD-R2-13：以下 4 行来自 R2 报告实测行为表，覆盖 tryFixEscapedQuotes 的 : 分支与失败面。
  it('QD-R2-13 行1：键名/值都合法 → 正常解析', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<shell_exec>{"command":"echo a"}</shell_exec>');
    expect(r.calls[0].params).toEqual({ command: 'echo a' });
  });

  it('QD-R2-13 行2：值内含裸引号紧跟冒号 → 安全失败 __invalid_json（不产错值）', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<shell_exec>{"command":"echo "a": 1"}</shell_exec>');
    expect(r.calls[0].params.__invalid_json).toBe(true);
  });

  it('QD-R2-13 行3：值内裸引号 → __invalid_json，兄弟字段一并丢失', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<shell_exec>{"command":"grep "x": y","cwd":"."}</shell_exec>');
    expect(r.calls[0].params.__invalid_json).toBe(true);
    expect(r.calls[0].params.cwd).toBeUndefined();
  });

  it('QD-R2-13 行4：嵌套对象值内引号 → 修复成功', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<shell_exec>{"params":{"p":"a"b"}}</shell_exec>');
    expect(r.calls[0].params.__invalid_json).toBeUndefined();
    expect((r.calls[0].params.params as { p: string }).p).toBe('a"b');
  });
});

describe('StreamingToolCallParser - 未闭合已知工具标签', () => {
  it('识别完整开标签后的未闭合 JSON', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<shell_exec>{"command":"ls');
    expect(r.hasUnclosedToolTag).toBe(true);
  });

  it('识别已知工具名的前缀', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<shell_ex');
    expect(r.hasUnclosedToolTag).toBe(true);
  });

  it('跨 chunk 拼接后仍能识别并完成解析', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    expect(p.feed('<shell_ex').hasUnclosedToolTag).toBe(true);
    const r = p.feed('ec>{"command":"ls"}</shell_exec>');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].params).toEqual({ command: 'ls' });
    expect(r.hasUnclosedToolTag).toBe(false);
  });

  it('不把比较符 a < b 误判为未闭合工具标签', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('a < b');
    expect(r.clean).toBe('a < b');
    expect(r.hasUnclosedToolTag).toBe(false);
  });

  it('不把孤立 < 误判为未闭合工具标签', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<');
    expect(r.clean).toBe('');
    expect(r.hasUnclosedToolTag).toBe(false);
    expect(p.flush()).toEqual({ calls: [], clean: '<', hasUnclosedToolTag: false });
  });

  it('不把未知 <foo> 误判为未闭合工具标签', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<foo>bar');
    expect(r.clean).toBe('<foo>bar');
    expect(r.hasUnclosedToolTag).toBe(false);
  });

  it('完整闭合标签不算未闭合', () => {
    const p = new StreamingToolCallParser(['shell_exec']);
    const r = p.feed('<shell_exec>{"command":"ls"}</shell_exec>');
    expect(r.calls).toHaveLength(1);
    expect(r.hasUnclosedToolTag).toBe(false);
  });
});
