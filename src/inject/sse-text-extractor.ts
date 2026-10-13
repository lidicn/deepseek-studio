/**
 * SSE → 可见纯文本 流式提取器（v0.7，自包容，无上游依赖）
 *
 * DeepSeek 对话响应是 SSE 流，文本通过两类 delta 到达：
 *   1. 单字符增量：data: {"v":"<char>"}
 *   2. fragment 批量追加：data: {"p":"response/fragments","o":"APPEND",
 *        "v":[{"id":3,"type":"RESPONSE","content":"<字符或整段>"}]}
 *
 * 工具调用标签的首字符 `<` 实测由第 2 类「fragment APPEND 数组事件」携带，而该事件体
 * 明显大于单字符 delta。XHR 的 onreadystatechange 按累计 responseText 的字节偏移切增量，
 * 一个完整的 `data: {...}\n` 事件可能正好被切在两次回调之间：上半段不是完整 data 行、
 * 下半段也不是，旧的无状态 extractSseText 对两段分别 JSON.parse 全部失败，整个事件
 * （连同标签首字符 `<`）被静默丢弃，导致 `<shell_exec>` 退化成 `shell_exec>`，工具标签
 * 永远无法被识别。
 *
 * 本提取器是有状态的：维护跨 chunk 的「不完整行缓冲」，只有遇到换行才判定一行结束并
 * 解析；被切开的事件先留在缓冲区，等下一个 chunk 补齐闭合后再解析，从而保证事件不丢。
 */

/**
 * 解析一行 SSE，返回其中携带的可见文本。非 data 行 / 心跳 / 无法解析的残行返回空串。
 */
export function extractTextFromSseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  let obj: { v?: unknown };
  try {
    obj = JSON.parse(payload) as { v?: unknown };
  } catch {
    // 残行 / 非 JSON 控制事件：忽略
    return '';
  }
  if (typeof obj.v === 'string') {
    return obj.v;
  }
  if (Array.isArray(obj.v)) {
    // BATCH/APPEND：v 是 fragment 对象数组，content 字段是文本
    // 过滤 type=THINK 的推理段，只保留 type=RESPONSE 的可见回答
    let out = '';
    for (const item of obj.v) {
      if (!item || typeof item !== 'object') continue;
      const frag = item as { type?: unknown; content?: unknown };
      if (frag.type === 'THINK') continue;
      if (typeof frag.content === 'string') out += frag.content;
    }
    return out;
  }
  return '';
}

/**
 * 有状态的 SSE 文本提取器。每个 HTTP 响应流（fetch）或每个 XHR 对象持有一个实例，
 * 逐 chunk 喂入原始 SSE 文本，吐出累积的可见纯文本。
 *
 * v0.9：跟踪当前活跃 fragment 类型（THINK/RESPONSE），过滤 THINK 推理段的单字符增量。
 */
export class SseTextStreamExtractor {
  /** 尚未遇到换行的不完整行（跨 chunk 保留）。 */
  private lineBuffer = '';
  /** 当前活跃 fragment 类型：THINK 时跳过单字符增量，RESPONSE 时保留。 */
  private activeFragmentType: 'THINK' | 'RESPONSE' | null = null;
  /** v0.18：累积 THINK 推理段文本，供步骤流推理笔记使用。 */
  private reasoningBuffer = '';

  /**
   * 喂入一段原始 SSE 文本（可能在任意字节边界截断），返回本次可确认的完整行所携带的文本。
   * 被切开的末行不解析，留待下次 feed 与新内容拼接后再处理。
   */
  feed(rawChunk: string): string {
    const combined = this.lineBuffer + rawChunk;
    const lines = combined.split('\n');
    this.lineBuffer = lines.pop() ?? '';
    let out = '';
    for (const line of lines) {
      out += this.extractLine(line);
    }
    return out;
  }

  /** 流结束时调用：尝试解析缓冲区里最后的残留行。 */
  flush(): string {
    const tail = this.lineBuffer;
    this.lineBuffer = '';
    return this.extractLine(tail);
  }

  /** v0.18：取出并清空已累积的推理文本。 */
  consumeReasoning(): string {
    const r = this.reasoningBuffer;
    this.reasoningBuffer = '';
    return r;
  }

  /** 解析一行 SSE，更新 fragment 类型状态，返回可见文本（THINK 段写入推理缓冲，返回空串）。 */
  private extractLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return '';
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return '';
    let obj: { v?: unknown; p?: unknown };
    try {
      obj = JSON.parse(payload) as { v?: unknown; p?: unknown };
    } catch {
      return '';
    }
    // fragment APPEND 事件：更新当前活跃 fragment 类型，并提取其中 RESPONSE 的 content
    if (obj.p === 'response/fragments' && Array.isArray(obj.v)) {
      for (const item of obj.v) {
        if (item && typeof item === 'object') {
          const t = (item as { type?: unknown }).type;
          if (t === 'THINK' || t === 'RESPONSE') this.activeFragmentType = t;
        }
      }
      let out = '';
      for (const item of obj.v) {
        if (!item || typeof item !== 'object') continue;
        const frag = item as { type?: unknown; content?: unknown };
        if (typeof frag.content !== 'string') continue;
        if (frag.type === 'THINK') {
          this.reasoningBuffer += frag.content;
        } else {
          out += frag.content;
        }
      }
      return out;
    }
    // 单字符增量：只在活跃 fragment 是 RESPONSE（或未知）时保留
    // 过滤 response/status、response/fragments/-1/elapsed_secs 等控制事件
    // v1.6：放宽 path 匹配——DeepSeek 可能用具体 fragment 索引（如
    // response/fragments/0/content）下发内容 delta，不只 -1。只硬编码 -1 会导致
    // 工具标签字符走非 -1 路径时被整体丢弃（标签留在 DOM 不被解析）。
    // 对齐 deepseek-pp stream-codec.ts isResponseTextPatchPath：接受任意
    // response/fragments/<index>/content，拒绝 status/elapsed_secs 等控制字段。
    if (typeof obj.v === 'string') {
      const p = String(obj.p ?? '');
      if (p && !isResponseContentPatchPath(p)) return '';
      if (this.activeFragmentType === 'THINK') {
        this.reasoningBuffer += obj.v;
        return '';
      }
      return obj.v;
    }
    // BATCH 数组
    if (Array.isArray(obj.v)) {
      let out = '';
      for (const item of obj.v) {
        if (!item || typeof item !== 'object') continue;
        const frag = item as { type?: unknown; content?: unknown };
        if (typeof frag.content !== 'string') continue;
        if (frag.type === 'THINK') {
          this.reasoningBuffer += frag.content;
        } else {
          out += frag.content;
        }
      }
      return out;
    }
    return '';
  }
}

/**
 * v1.6：判断 SSE patch path 是否是 response 内容 delta（接受任意 fragment 索引）。
 * 接受：response/content、response/fragments/-1/content、response/fragments/0/content 等
 * 拒绝：response/status、response/fragments/-1/elapsed_secs、response/vote_status 等控制字段
 * 对齐 deepseek-pp stream-codec.ts isResponseTextPatchPath 的宽松匹配。
 */
function isResponseContentPatchPath(path: string): boolean {
  if (!path.startsWith('response')) return false;
  const lastSegment = path.split('/').pop();
  // 只认内容字段，拒绝 status/elapsed_secs/vote_status 等控制字段
  return lastSegment === 'content' || lastSegment === 'text' || lastSegment === 'markdown' || lastSegment === 'delta';
}

/**
 * 无状态一次性提取（仅用于对「已完整的 SSE 文本」做离线解析 / 单测）。
 * 增量场景请使用 SseTextStreamExtractor，切勿对每个网络分片单独调用本函数。
 */
export function extractSseText(rawChunk: string): string {
  const extractor = new SseTextStreamExtractor();
  let out = extractor.feed(rawChunk);
  out += extractor.flush();
  return out;
}
