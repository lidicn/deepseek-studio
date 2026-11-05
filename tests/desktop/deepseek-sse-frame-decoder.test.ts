import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DeepSeekSseFrameDecoder,
  framesSignalStreamCompletion,
} from '../../src/inject/deepseek-sse-frame-decoder';
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

/**
 * SSE 收尾帧判定修正（PM 卡 2026-11-05）：「只有 event: 行、没有 data: 行」的帧
 * （如裸 `event: close`）必须让 event 对象存在 —— 旧实现按 `data ?` 判定会让
 * event 变 null，`framesSignalStreamCompletion` 拿不到 `event: close` 的 type。
 * 真实流量里 `event: close` 全部带 data（16/16），所以这是**防御性修正**；
 * 负控 = 退回 `data ? ... : null` ⇒ 本组用例转红。
 */
describe('DeepSeekSseFrameDecoder：event 行无 data 帧（收尾帧判定修正）', () => {
  it('裸 `event: close`（无 data）→ framesSignalStreamCompletion 返回 true', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push('event: close\n\n');
    expect(frames.length).toBe(1);
    expect(frames[0].event).toEqual({ type: 'close', data: '' });
    expect(framesSignalStreamCompletion(frames)).toBe(true);
  });

  it('跨 chunk 的裸 close 帧（event 行与空行分片）同样判 true', () => {
    const dec = new DeepSeekSseFrameDecoder();
    expect(dec.push('event: close\n').length).toBe(0); // 未遇空行边界
    const frames = dec.push('\n');
    expect(frames.length).toBe(1);
    expect(framesSignalStreamCompletion(frames)).toBe(true);
  });

  it('语义对齐：无 event 行但有 data → event 对象仍非 null（type 默认 message，原行为不变）', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push('data: {"v":"x"}\n\n');
    expect(frames[0].event).not.toBeNull();
    expect(frames[0].event!.type).toBe('message');
  });

  it('语义对齐：既无 event 行也无 data → event 为 null（原行为不变）', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push('retry: 3\n\n');
    expect(frames.length).toBe(1);
    expect(frames[0].event).toBeNull();
  });

  it('真实形态：`event: close` 带 data（16/16 抓包形态）→ 仍判 true', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push('event: close\ndata: {"click_behavior":"none","auto_resume":false}\n\n');
    expect(framesSignalStreamCompletion(frames)).toBe(true);
  });

  it('源码锁：event 存在性判据是 hasEventLine（改回 data ? … ⇒ 红）', () => {
    // 负控（PM 卡要求）：若有人把 createFrame 退回 `const event = data ? … : null`
    // （丢掉 hasEventLine 判据），上面「裸 close」两条用例必红。
    // 源码级锁死判据，防悄悄回退。路径相对仓库根（vitest 从仓库根启动）。
    const src = readFileSync('src/inject/deepseek-sse-frame-decoder.ts', 'utf8');
    expect(src).toMatch(/hasEventLine/);
    expect(src).toMatch(/hasEventLine \|\| data/);
  });
});
