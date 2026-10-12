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
