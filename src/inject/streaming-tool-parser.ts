/**
 * 流式 XML 工具调用解析器（v0.6，自包容，无上游依赖）
 *
 * 上游 DeepSeek 以 XML 调用标签形式在流式响应中返回工具调用，例如：
 *   <shell_exec>{"command":"ls -la"}</shell_exec>
 *   <local_file_read>{"path":"/a/b.txt"}</local_file_read>
 *
 * 本模块是上游 streaming-tool-call-parser 算法的等价移植（逐行复刻其「增量扫描 +
 * 跨块保留未闭合标签尾部 + 解析 JSON 参数」行为），之所以不直接 import 上游源码，
 * 是因为 deepseek-pp 的 core 依赖 WXT/chrome 类型与自身更宽松的 lint 配置，无法在本
 * 项目严格 tsconfig 下编译。运行时行为与上游客流一致，且零浏览器扩展耦合。
 */

export interface ParsedToolCall {
  readonly id: string;
  readonly invocationName: string;
  readonly params: Record<string, unknown>;
  readonly raw: string;
}

export class StreamingToolCallParser {
  private tail = '';

  constructor(private readonly names: readonly string[]) {}

  /**
   * 喂入一段响应文本，返回本次新解析出的完整工具调用，以及已剔除工具标签的「干净」文本
   * （用于回填到页端可见流，避免用户看到原始 XML 标签）。未完成闭合的标签尾部被保留到
   * 下次 feed，保证跨网络分片正确。
   */
  feed(text: string): { calls: ParsedToolCall[]; clean: string } {
    const input = this.tail + text;
    this.tail = '';
    const calls: ParsedToolCall[] = [];
    let clean = '';
    let i = 0;
    while (i < input.length) {
      const lt = input.indexOf('<', i);
      if (lt === -1) {
        clean += input.slice(i);
        break;
      }
      clean += input.slice(i, lt);
      const after = input.slice(lt);
      const open = after.match(/^<([a-zA-Z_][\w-]*)>/);
      if (open && this.names.includes(open[1])) {
        const name = open[1];
        const openEnd = lt + open[0].length;
        const closeTag = `</${name}>`;
        const closeIdx = input.indexOf(closeTag, openEnd);
        if (closeIdx === -1) {
          // 标签未闭合：把剩余整体留到下次（避免把不完整标签暴露给用户）
          this.tail = input.slice(lt);
          break;
        }
        const body = input.slice(openEnd, closeIdx);
        const rawBlock = input.slice(lt, closeIdx + closeTag.length);
        calls.push(this.make(name, body, rawBlock));
        i = closeIdx + closeTag.length;
      } else {
        const close = after.match(/^<\/([a-zA-Z_][\w-]*)>/);
        if (close && this.names.includes(close[1])) {
          // 受支持工具的悬空闭合标签：丢弃
          i = lt + close[0].length;
        } else if (/^<\/?[a-zA-Z_][\w-]*$/.test(after) || /^<\/?$/.test(after)) {
          // 跨 chunk 的未完成标签前缀：DeepSeek 逐字符 delta 下发时，开标签首字符 `<`
          // （甚至 `<name` 的若干前缀字符）会先于闭合的 `>` 单独到达，此时既匹配不到完整
          // 开标签也匹配不到闭合标签。必须把从 `<` 到末尾的整段留到下次 feed 拼接后再判定，
          // 否则这个 `<` 会被当作普通文本永久消费，工具标签再也拼不起来。
          // 仅当 `<` 之后到结尾全是合法标签名字符（或恰为 `<` / `</`）时才乐观保留；
          // 一旦出现空格、第二个 `<`、`>` 等否定字符，即按普通文本处理（如 a < b、</3）。
          this.tail = input.slice(lt);
          break;
        } else {
          // 普通文本中的孤立 `<`（比较符 a < b、表情 </3、非工具名标签 <foo> 等）：
          // 必须原样放回干净文本，不得静默吞掉字符。
          clean += '<';
          i = lt + 1;
        }
      }
    }
    return { calls, clean };
  }

  /** 流结束时刷出剩余尾部（作为干净文本返回，不解析不完整标签）。 */
  flush(): { calls: ParsedToolCall[]; clean: string } {
    const clean = this.tail;
    this.tail = '';
    return { calls: [], clean };
  }

  private make(name: string, body: string, raw: string): ParsedToolCall {
    let params: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') params = parsed as Record<string, unknown>;
    } catch (e) {
      // F3 修复：JSON 解析失败时标记错误，让模型看到确切原因，而不是静默交空对象
      params = { __invalid_json: true, __error: e instanceof Error ? e.message : String(e), __raw: body };
    }
    const id =
      typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return { id, invocationName: name, params, raw };
  }
}
