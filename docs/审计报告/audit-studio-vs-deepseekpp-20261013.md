# 审计报告：studio 与 deepseek++ 执行同一任务的结果差异与根因

- 日期：2026-10-13
- 对象：E:\NAS\deepseek-studio 与 E:\NAS\deepseek-pp
- 结论等级：已定位根因（含字符级证据，记忆 id 35）

## 一、现象

同一句工具调用，在两个系统中结果不同：

- studio（图一）：工具参数解析失败
  - 报错：invalid-tool-json: Expected , or } after property value in JSON at position 44 (line 1 column 45)
  - __raw 保存了原始 body（含 powershell -NoProfile -Command 命令）
- deepseek++（图二）：同一句命令正常执行，输出 E:/NAS/AutoForge/docs/audit 的目录列表（.claude、propose_round005、元宝、参考、归档、待裁决、.gitkeep、AutoForge_第四期审计报告_全本_第一至二十轮.md、index.md）

## 二、字符级证据

原始 body（去掉外层包装后）：

{"command":"powershell -NoProfile -Command \"Get-ChildItem -LiteralPath E:/NAS/AutoForge/docs/audit -Force | Select-Object Name, Length, LastWriteTime, Mode | Format-Table -AutoSize\""}

位置索引：

| 位置 | 字符 | 说明 |
| --- | --- | --- |
| 0 | { | 对象开始 |
| 1-10 | "command" | 键名 |
| 11 | : | 冒号 |
| 12 | " | 值起始引号 |
| 13-41 | powershell -NoProfile -Command + 空格 | 命令头 |
| 42 | 反斜杠 | 转义符 |
| 43 | " | 被转义的引号 |
| 44 | G | 解析器报错位置 |

解析器在 position 44 报「期望逗号或右花括号」，唯一可能是 position 43 的引号被当作字符串结束引号 —— 也就是说 position 42 的反斜杠已经不在 body 里。

结论：反斜杠丢失，转义序列「反斜杠 + 双引号」退化为裸双引号，JSON 字符串在 position 43 提前闭合，position 44 报错。

## 三、根因

studio 把工具调用参数解析建立在一条「为显示而改写文本」的有损链路上：

```
window.fetch 包装
  -> SseTextStreamExtractor.feed()   逐换行切分 + 过滤 THINK/RESPONSE + 剥离工具标签
  -> StreamingToolCallParser.feed()  正则抓取工具标签
  -> JSON.parse(body)                在 position 44 失败
```

这条链路同时承担两个互相冲突的目标：

1. 给人看：要删除工具标签、要滤掉 THINK 推理段，必须改写文本；
2. 给解析器用：参数必须逐字节精确，一个字符都不能动。

在处理含转义引号的 PowerShell 命令时，THINK/RESPONSE 切换或跨 chunk 行缓冲把反斜杠归错桶或丢失。studio 的 F3 修复只是把炸后现场存进 __invalid_json/__raw，属于事后取证，不是防错。

deepseek++ 为什么对（src/core/deepseek/stream-codec.ts）：

1. createDeepSeekSseFrameDecoder 按空行（正则匹配回车可选 + 换行 + 回车可选 + 换行）切 frame，用 scanFrom = max(0, buffer.length - 3) 回看窗口，保证跨 chunk 边界帧补齐后再解析；
2. consumeDeepSeekSseEvents 让 assistantText（给人看）和 assistantReasoningText（推理段）各自独立累积，工具解析走原始 frame 的 parsed，不经过任何显示用改写；
3. createDeepSeekSseByteDecoder 用 TextDecoder(stream:true) 解原始字节，转义序列只解析一次，不会多层损耗。

所以 deepseek++ 拿到的 body 里转义引号完整，JSON.parse 一次通过，直接进入已执行 shell_exec。

## 四、对比

| 维度 | studio（错） | deepseek++（对） |
| --- | --- | --- |
| 切分单位 | 按单个换行逐行 | 按空行切 frame |
| 跨 chunk | lineBuffer 与显示滤 THINK 混用 | scanFrom 回看窗口，边界帧补齐 |
| 双通道 | 无，工具解析建在可见文本输出上 | 有，assistantText / assistantReasoningText 独立，工具解析走原始 frame |
| 编码 | 文本层多层搬运，转义易损 | TextDecoder(stream:true) 解原始字节，转义只解析一次 |
| 失败表现 | position 44 JSON 报错 | 正常执行 |

## 五、一句话根因

studio 用同一条有损的可见文本提取管道既负责显示、又负责工具参数保真，处理含转义引号的 PowerShell 命令时吞掉反斜杠导致 JSON 崩溃；deepseek++ 用按空行切 frame、跨 chunk 缓冲的 SSE 解码器，并让工具调用与可见文本走两条独立通道，因此保住了转义字符。

## 六、修复建议（按优先级）

1. 工具解析脱离 SseTextStreamExtractor：在原始 SSE chunk 上另起一条纯 frame 解析通道（照搬 deepseek++ 的空行切 frame + scanFrom 方案）；
2. StreamingToolCallParser.make 加容错：parse 失败时对 __raw 做补反斜杠修复（把字符串值内未转义的裸引号重新转义）再 parse 一次；
3. 加断言：解析出的 params.command 若含未配对引号则标记可疑并回退；
4. 长期：按路线 C 自建 Tauri 宿主，从网络层直接拿原始响应体，彻底消除文本提取损耗。

## 七、附：证据文件

- studio 侧：E:/NAS/deepseek-studio/src/inject/sse-text-extractor.ts、streaming-tool-parser.ts、main-world-interceptor.ts
- deepseek++ 侧：E:/NAS/deepseek-pp/src/core/deepseek/stream-codec.ts、src/core/chat/active-loop.ts
- 记忆：#35 studio vs deepseek++ 工具调用 JSON 转义根因
