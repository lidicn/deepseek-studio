/**
 * v1.5：DeepSeek SSE frame 解码器（照搬 deepseek++ stream-codec.ts）
 *
 * 与 SseTextStreamExtractor 的区别：
 * - SseTextStreamExtractor：按单换行切分，同时负责显示文本提取和工具解析，转义易损
 * - DeepSeekSseFrameDecoder：按空行切 frame，跨 chunk 回看窗口，frame.parsed 独立于显示文本
 *
 * 用法：
 *   const dec = new DeepSeekSseFrameDecoder();
 *   for (const frame of dec.push(rawChunk)) {
 *     // frame.parsed 是 JSON.parse(event.data) 的结果，直接用来提取工具调用
 *     // 不经过任何显示用改写
 *   }
 */

export interface DeepSeekSseFrame {
  readonly block: string;
  readonly event: { type: string; data: string } | null;
  readonly parsed: unknown | null;
}

export class DeepSeekSseFrameDecoder {
  private buffer = '';
  private scanFrom = 0;

  push(text: string): DeepSeekSseFrame[] {
    this.buffer += text;
    return this.drain();
  }

  finish(): DeepSeekSseFrame[] {
    const frames = this.drain();
    if (this.buffer) {
      frames.push(this.createFrame(this.buffer, ''));
      this.buffer = '';
    }
    this.scanFrom = 0;
    return frames;
  }

  private drain(): DeepSeekSseFrame[] {
    const frames: DeepSeekSseFrame[] = [];
    const boundaryPattern = /\r?\n\r?\n/g;
    boundaryPattern.lastIndex = this.scanFrom;
    let offset = 0;
    let match: RegExpExecArray | null;

    while ((match = boundaryPattern.exec(this.buffer)) !== null) {
      frames.push(this.createFrame(this.buffer.slice(offset, match.index), match[0]));
      offset = match.index + match[0].length;
    }

    this.buffer = this.buffer.slice(offset);
    this.scanFrom = Math.max(0, this.buffer.length - 3);
    return frames;
  }

  private createFrame(block: string, _separator: string): DeepSeekSseFrame {
    // 解析 SSE event：每行 "key: value"
    let eventType = 'message';
    let dataLines: string[] = [];
    for (const line of block.split('\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trimStart();
      if (key === 'event') eventType = value;
      else if (key === 'data') dataLines.push(value);
    }
    const data = dataLines.join('\n');
    const event = data ? { type: eventType, data } : null;
    let parsed: unknown = null;
    if (data) {
      try {
        parsed = JSON.parse(data);
      } catch {
        // 非 JSON 数据，忽略
      }
    }
    return { block, event, parsed };
  }
}

/**
 * 从 frame.parsed 里提取可见文本和工具调用。
 * 独立于 SseTextStreamExtractor，不经过显示用改写。
 */
export function extractFromParsed(parsed: unknown): {
  visibleText: string;
  reasoningText: string;
  hasToolCall: boolean;
} {
  let visibleText = '';
  let reasoningText = '';
  let hasToolCall = false;

  if (!parsed || typeof parsed !== 'object') {
    return { visibleText, reasoningText, hasToolCall };
  }

  const obj = parsed as Record<string, unknown>;

  // BATCH/APPEND：v 是 fragment 对象数组
  if (Array.isArray(obj.v)) {
    for (const item of obj.v) {
      if (!item || typeof item !== 'object') continue;
      const frag = item as { type?: unknown; content?: unknown };
      if (typeof frag.content !== 'string') continue;
      if (frag.type === 'THINK') {
        reasoningText += frag.content;
      } else if (frag.type === 'RESPONSE') {
        visibleText += frag.content;
      }
    }
  }

  return { visibleText, reasoningText, hasToolCall };
}

/**
 * QD-R4-03：判断这批 frame 里是否带「流正常结束」哨兵。
 *
 * 早期实现按通用 SSE 惯例找 `data: [DONE]`，但实测 DeepSeek 的 chat/completion
 * 流**从不下发 `[DONE]`**（`logs/cdp-chat-capture/` 20 份真实抓包全部 DONE=False）。
 * 真正的完成信号是二者之一：
 *   1. `data: {"p":"response/status","o":"SET","v":"FINISHED"}`
 *   2. `data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}`
 * 另有 `event: close` 帧作为流的收尾。
 *
 * 必须按 frame 判定而不是在原始 chunk 上做 includes：readyState 回调按累计
 * responseText 的字节偏移切增量，一个 frame 可能被切在两次回调之间，
 * 对 `part` 做子串匹配会漏判 → 把正常完成的流误判成截断。
 */
export function framesSignalStreamCompletion(frames: readonly DeepSeekSseFrame[]): boolean {
  for (const frame of frames) {
    const eventType = frame.event?.type;
    if (eventType && eventType.toLowerCase() === 'close') return true;
    const parsed = frame.parsed as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.p === 'response/status' && parsed.v === 'FINISHED') return true;
    if (parsed.p === 'response' && Array.isArray(parsed.v)) {
      for (const item of parsed.v) {
        if (!item || typeof item !== 'object') continue;
        const patch = item as Record<string, unknown>;
        if (patch.p === 'quasi_status' && patch.v === 'FINISHED') return true;
      }
    }
  }
  return false;
}
