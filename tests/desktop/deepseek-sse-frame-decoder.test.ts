import { describe, it, expect } from 'vitest';
import { DeepSeekSseFrameDecoder } from '../../src/inject/deepseek-sse-frame-decoder';
import { StreamingToolCallParser } from '../../src/inject/streaming-tool-parser';

describe('DeepSeekSseFrameDecoder', () => {
  it('按空行切 frame', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const chunk = `event: patch
data: {"v":[{"type":"RESPONSE","content":"hello"}]}\n\n`;
    const frames = dec.push(chunk);
    expect(frames.length).toBe(1);
    expect(frames[0].parsed).toBeTruthy();
    const p = frames[0].parsed as { v: Array<{ type: string; content: string }> };
    expect(p.v[0].content).toBe('hello');
  });

  it('跨 chunk 边界帧补齐', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const part1 = `event: patch\ndata: {"v":[{"type":"RESPONSE","content":"hel`;
    const part2 = `lo"}]}\n\n`;
    const frames1 = dec.push(part1);
    expect(frames1.length).toBe(0);
    const frames2 = dec.push(part2);
    expect(frames2.length).toBe(1);
    const p = frames2[0].parsed as { v: Array<{ type: string; content: string }> };
    expect(p.v[0].content).toBe('hello');
  });

  it('工具调用含转义引号不被吞掉', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const parser = new StreamingToolCallParser(['shell_exec']);
    // 用 JSON.stringify 构造正确的嵌套 JSON，避免手动转义出错
    const innerJson = JSON.stringify({
      command: 'powershell -NoProfile -Command "Get-ChildItem E:/test"',
    });
    const wrapper = JSON.stringify({
      v: [{ type: 'RESPONSE', content: `<shell_exec>${innerJson}</shell_exec>` }],
    });
    const chunk = `event: patch\ndata: ${wrapper}\n\n`;
    const frames = dec.push(chunk);
    expect(frames.length).toBe(1);
    // 从 frame.parsed 里提取原始 content（未 JSON 转义）
    let rawDataText = '';
    const p = frames[0].parsed as { v?: Array<{ type?: string; content?: string }> };
    if (Array.isArray(p.v)) {
      for (const frag of p.v) {
        if (typeof frag.content === 'string') rawDataText += frag.content;
      }
    }
    const { calls } = parser.feed(rawDataText);
    expect(calls.length).toBe(1);
    expect(calls[0].invocationName).toBe('shell_exec');
    if (calls[0].params.__invalid_json) {
      console.log('ERROR:', calls[0].params.__error);
      console.log('RAW:', calls[0].params.__raw);
    }
    expect(calls[0].params.__invalid_json).toBeFalsy();
    expect(typeof calls[0].params.command).toBe('string');
    expect(calls[0].params.command).toContain('Get-ChildItem');
  });
});
