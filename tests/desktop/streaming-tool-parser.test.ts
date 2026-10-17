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
});
