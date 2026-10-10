import { describe, it, expect } from 'vitest';
import {
  SseTextStreamExtractor,
  extractTextFromSseLine,
  extractSseText,
} from '../../src/inject/sse-text-extractor';
import { StreamingToolCallParser, type ParsedToolCall } from '../../src/inject/streaming-tool-parser';

const TOOL_NAMES = ['shell_exec', 'local_file_read', 'local_file_write', 'local_file_stat'];

/** 构造模型输出一个工具标签的真实 SSE 流；首字符 `<` 由 fragment APPEND 数组事件携带。 */
function buildToolCallStream(tag: string, jsonBody: string): string {
  const events: string[] = [
    'data: {"v":" I will call the tool."}',
    '',
    // 标签首字符 `<` 走 fragment APPEND 数组事件（线上实测形态）
    'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"<","references":[],"stage_id":1}]}',
    '',
  ];
  // 标签名剩余部分 + JSON + 闭合标签，逐段走普通字符串 delta
  const rest = `${tag}>${jsonBody}</${tag}>`;
  for (const ch of rest) {
    events.push(`data: {"v":${JSON.stringify(ch)}}`);
  }
  events.push('', 'event: close', 'data: {"click_behavior":"none"}', '');
  return events.join('\n');
}

/** 模拟 XHR onreadystatechange：按固定字节宽度把流切成多个 part。 */
function splitIntoParts(stream: string, width: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < stream.length; i += width) {
    parts.push(stream.slice(i, i + width));
  }
  return parts;
}

describe('SseTextStreamExtractor', () => {
  it('完整流一次性提取（对照）：保留标签首字符 <', () => {
    const stream = buildToolCallStream('local_file_read', '{"path":"x"}');
    const text = extractSseText(stream);
    expect(text).toContain('<local_file_read>{"path":"x"}</local_file_read>');
  });

  it('回归：fragment APPEND 事件跨 chunk 被切开时，标签首字符 < 不丢失', () => {
    const stream = buildToolCallStream('local_file_read', '{"path":"x"}');
    // 旧无状态实现会在任意切点丢失被切开事件；用多个宽度穷举，保证任何字节边界都安全
    for (const width of [1, 7, 16, 32, 64, 100, 128]) {
      const extractor = new SseTextStreamExtractor();
      let assembled = '';
      for (const part of splitIntoParts(stream, width)) {
        assembled += extractor.feed(part);
      }
      assembled += extractor.flush();
      expect(assembled, `width=${width}`).toContain(
        '<local_file_read>{"path":"x"}</local_file_read>',
      );
    }
  });

  it('跨 chunk 后串联 StreamingToolCallParser，能识别出完整工具调用', () => {
    const stream = buildToolCallStream('shell_exec', '{"command":"dir /a"}');
    const sse = new SseTextStreamExtractor();
    const parser = new StreamingToolCallParser(TOOL_NAMES);
    const calls: ParsedToolCall[] = [];
    for (const part of splitIntoParts(stream, 23)) {
      const visible = sse.feed(part);
      if (visible) {
        const r = parser.feed(visible);
        calls.push(...r.calls);
      }
    }
    const tail = sse.flush();
    if (tail) calls.push(...parser.feed(tail).calls);
    calls.push(...parser.flush().calls);

    expect(calls).toHaveLength(1);
    expect(calls[0].invocationName).toBe('shell_exec');
    expect(calls[0].params).toEqual({ command: 'dir /a' });
  });

  it('普通字符串 delta 跨 chunk 正确拼接', () => {
    const sse = new SseTextStreamExtractor();
    const p1 = 'data: {"v":"hel' ; // 残行（无换行），应被缓冲
    const p2 = 'lo"}\n\ndata: {"v":" world"}\n\n';
    let out = sse.feed(p1);
    out += sse.feed(p2);
    out += sse.flush();
    expect(out).toBe('hello world');
  });

  it('BATCH 数组事件（多 fragment content）全部提取', () => {
    const line =
      'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"ab"},{"type":"RESPONSE","content":"cd"}]}';
    expect(extractTextFromSseLine(line)).toBe('abcd');
  });

  it('忽略非 data 行、心跳与 [DONE]', () => {
    expect(extractTextFromSseLine('event: ready')).toBe('');
    expect(extractTextFromSseLine('data: [DONE]')).toBe('');
    expect(extractTextFromSseLine(': keepalive')).toBe('');
  });

  it('flush 处理最后一个不带换行的残留事件', () => {
    const sse = new SseTextStreamExtractor();
    const out = sse.feed('data: {"v":"tail"}'); // 无结尾换行
    expect(out).toBe('');
    expect(sse.flush()).toBe('tail');
  });
});

describe('StreamingToolCallParser 逐字符 delta 边界', () => {
  /** 逐字符喂入（模拟 DeepSeek 单字符 delta 提取后的最小 visible 片段）。 */
  function feedCharByChar(full: string, chunk = 1): { calls: ParsedToolCall[]; clean: string } {
    const parser = new StreamingToolCallParser(TOOL_NAMES);
    const calls: ParsedToolCall[] = [];
    let clean = '';
    for (let i = 0; i < full.length; i += chunk) {
      const r = parser.feed(full.slice(i, i + chunk));
      calls.push(...r.calls);
      clean += r.clean;
    }
    const fin = parser.flush();
    calls.push(...fin.calls);
    clean += fin.clean;
    return { calls, clean };
  }

  it('完整标签逐字符喂入仍能识别（首字符 < 单独到达）', () => {
    const { calls, clean } = feedCharByChar('<shell_exec>{"command":"ls"}</shell_exec>');
    expect(calls).toHaveLength(1);
    expect(calls[0].invocationName).toBe('shell_exec');
    expect(calls[0].params).toEqual({ command: 'ls' });
    // 标签被剥离，干净文本不含原始 XML
    expect(clean).not.toContain('<shell_exec>');
  });

  it('开标签名跨 chunk（<she | ll_exec>）能拼合识别', () => {
    const parser = new StreamingToolCallParser(TOOL_NAMES);
    const a = parser.feed('<she');
    expect(a.calls).toHaveLength(0);
    const b = parser.feed('ll_exec>{"command":"pwd"}</shell_exec>');
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].params).toEqual({ command: 'pwd' });
  });

  it('body 内含 < 字符（shell 重定向）不影响闭合标签定位', () => {
    const { calls } = feedCharByChar('<shell_exec>{"command":"cat < a.txt"}</shell_exec>', 3);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ command: 'cat < a.txt' });
  });

  it('普通文本中的比较符 a < b 不被误判为工具标签', () => {
    const { calls, clean } = feedCharByChar('if a < b then stop');
    expect(calls).toHaveLength(0);
    expect(clean).toBe('if a < b then stop');
  });

  it('普通文本中的 </3 表情不被误判', () => {
    const { calls, clean } = feedCharByChar('love </3 forever');
    expect(calls).toHaveLength(0);
    expect(clean).toBe('love </3 forever');
  });

  it('非工具名的完整标签 <foo> 当作普通文本保留', () => {
    const { calls, clean } = feedCharByChar('note <foo>bar</foo> end');
    expect(calls).toHaveLength(0);
    expect(clean).toBe('note <foo>bar</foo> end');
  });
});
