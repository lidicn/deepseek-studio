# DeepSeek++ → DeepSeek Studio 移植计划

> 目标：把 deepseek++ 中通用、成熟的模块直接移植到 studio，避免重复造轮子，快速拉平能力差距。
>
> **状态：全部可移植模块已完成移植（2026-10-11）**

## 一、可移植模块盘点

| 优先级 | 模块 | 来源 | 大小 | 移植方式 | 状态 |
|--------|------|------|------|----------|------|
| P0 | 系统提示词 systemChat | background.js | ~2KB | 直接抄，替换占位符 | ✅ 已完成 |
| P0 | 续跑提示词 continuation/continuationEnough | background.js | ~200B | 直接抄 | ✅ 已完成 |
| P0 | 工具调用格式提醒 | background.js | ~500B | 直接抄 | ✅ 已完成 |
| P1 | SSE 流式解析器（部分标签+跨chunk保留） | main-world.js | ~30KB | 算法已等价移植 | ✅ 已完成 |
| P1 | 工具卡片 UI 样式（可展开容器+结果截断） | RichMessageContent.js | ~112KB | 参考视觉重写 | ✅ 已完成 |
| P1 | 工具结果回填格式 [TOOL_RESULTS] | main-world.js | ~1KB | 直接抄 | ✅ 已完成 |
| P2 | 工具记录数据结构（ToolCall/ToolResult/Record） | tool-record-codec.js | 3.5KB | 参考类型定义 | ✅ 已完成 |
| P2 | 请求增强（工具描述符注入+结果回填） | background.js | ~10KB | 核心功能已实现 | ✅ 已完成 |
| ❌ | MCP 工具控制器 | mcp-tools-controller.js | 16KB | Chrome扩展特有，不移植 | - |
| ❌ | 沙箱运行器 | sandbox-runner.js | 225KB | Chrome offscreen特有，不移植 | - |
| ❌ | 记忆系统 | background.js | ~50KB | studio暂不需要 | - |
| ❌ | 技能系统 | background.js | ~80KB | studio暂不需要 | - |

## 二、P0 阶段：提示词直接移植（1小时内完成）

### 2.1 系统提示词 systemChat

**deepseek++ 原文（已提取）**：
```
## Role
You are the user's personal AI assistant with long-term cross-conversation memory...

## Tools
You have access to tools. Call one by emitting an XML tag with the tool name and a valid JSON body:
<memory_save>{"type": "user", ...}</memory_save>

Rules: tag name MUST match an available tool; JSON body MUST be valid JSON on its own; 
place calls anywhere in your final answer (not in thinking sections); 
use forward slashes for local file paths.
Prohibited: wrapper formats (<invoke>/<tool_call>), pseudo tool-call JSON in code blocks, 
or claiming you cannot call listed tools.

### Extended Capabilities
...

### Available Tools
{tools}

## Existing Memories
{memories}

## Memory Saving Rules
...
```

**studio 适配**：
- 移除记忆相关部分（studio 无记忆系统）
- `{tools}` 替换为 studio 实际工具列表（shell_exec, local_file_read, local_file_write, local_file_stat）
- 保留 Extended Capabilities 框架（标注 Shell Local 已启用）
- 保留工具调用规则（正斜杠路径、禁止包装格式等）

### 2.2 续跑提示词

**deepseek++ 原文**：
- continuation: `Continue completing the automation based on these results.`
- continuationEnough: `If the results are enough, output the final answer. Only call more tools when more information, verification, or file changes are truly needed.`

**studio 适配**：直接用，作为 auto-continue 的系统提示词注入。

### 2.3 工具调用格式提醒

**deepseek++ 原文**：
```
Tool call format reminder:
Available tool tag names: <list>
These listed tools are executable by the extension.
To call a tool, use ONLY the direct XML tag
For MCP tools, prefer the short tag name
For local file paths, use forward slashes
Do not use <invoke name="...">
```

**studio 适配**：直接用，替换工具列表。

## 三、P1 阶段：核心模块移植（8小时）

### 3.1 SSE 流式解析器

**deepseek++ 架构**：
- `To()` 函数创建响应处理器，含 `append()`/`finish()` 方法
- 内部用 `StreamingToolCallParser` 解析 DSML 格式工具标签
- 支持部分标签（流式增量，标签可能被切分）
- 事件驱动：`onToolCallStarted`、`onToolCall`、`onToolCallChunk`、`onResponseComplete`
- 可见文本提取器：`getVisibleText()` 返回剥离工具标签后的纯文本

**studio 现状**：
- 已有 `streaming-tool-parser.ts`（基于 deepseek++ 算法移植）
- 已有 `sse-text-extractor.ts`（有状态 SSE 提取器）
- 缺少：部分标签处理、事件驱动架构、DSML 格式支持

**移植方案**：
- 参考 deepseek++ 的 `To()` 处理器架构，重构 studio 的 SSE 处理流程
- 支持部分标签（标签首字符 `<` 可能被切分到不同 chunk）
- 统一事件出口（工具开始/完成/失败、回复完成）

### 3.2 工具卡片 UI

**deepseek++ 实现**：
- RichMessageContent React 组件（112KB，CSS-in-JS）
- 工具卡片含：状态徽章、工具名、参数、结果、耗时
- "已调用工具（N次）"可展开区域
- 结果支持截断（大输出折叠）

**studio 现状**：
- 已有 `tool-card-ui.ts`（原生 JS 实现，基础卡片）
- 缺少：可展开区域、结果截断、与 deepseek++ 一致的样式

**移植方案**：
- 从 RichMessageContent 提取 CSS 样式常量（颜色、间距、字体）
- 增加"已调用工具（N次）"可展开头部
- 增加结果截断（>2KB 折叠，点击展开）
- 对齐 deepseek++ 的视觉风格

### 3.3 工具结果回填格式

**deepseek++ 格式**：
```
[TOOL_RESULTS]
## shell_exec
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "..."
}
## local_file_read
{
  "ok": true,
  "content": "..."
}
```

**studio 现状**：已有类似格式，但字段名可能不一致。

**移植方案**：对齐 deepseek++ 的字段名和格式，确保模型续跑时能正确解析。

## 四、P2 阶段：辅助模块（3小时）

### 4.1 工具记录数据结构
参考 `tool-record-codec.ts` 的类型验证，统一 studio 的 ToolCall/ToolResult 数据结构。

### 4.2 请求增强
参考 deepseek++ 的 `onRequestBody` 逻辑，在请求体中注入工具描述符、系统提示词、续跑指令。

## 五、执行顺序

1. **P0-提示词移植**（1h）— 立竿见影，模型行为立刻改善
2. **P1-工具结果回填格式**（0.5h）— 确保续跑稳定
3. **P1-工具卡片UI优化**（3h）— 视觉对齐 deepseek++
4. **P1-SSE解析器重构**（4h）— 提升健壮性，减少解析失败
5. **P2-数据结构统一**（1h）— 代码质量
6. **P2-请求增强**（2h）— 完善请求注入

## 六、验证标准

每个模块移植后：
- 通过 `/v1/agent/send` 发送测试消息（列目录、读文件、写文件）
- 验证工具调用成功率 > 95%
- 验证工具卡片正确显示（参数+结果+状态）
- 验证模型最终回答正确（无原始标签泄漏、无 FINISHED 字样）
- 验证连续多轮工具调用稳定（>5轮不崩溃）

## 七、移植完成总结（2026-10-11）

### 已完成的移植清单

| # | 模块 | 落地文件 | 说明 |
|---|------|----------|------|
| 1 | 系统提示词 | `src/inject/main-world-interceptor.ts` | 采用 deepseek++ 的结构（角色/工具调用/规则/禁止/扩展能力/可用工具），中文适配 |
| 2 | 续跑提示词 | `src/inject/main-world-interceptor.ts` | 用 deepseek++ 的 continuationEnough 风格："如果结果已经足够，请输出最终结论..." |
| 3 | 工具结果回填格式 | `src/inject/main-world-interceptor.ts` | 对齐 `[TOOL_RESULTS]...[/TOOL_RESULTS]` 格式 |
| 4 | 工具卡片 UI | `src/inject/tool-card-ui.ts` | 增加"已调用工具（N次）"可展开容器、结果>2KB自动折叠、状态脉冲动画、对齐 deepseek++ 视觉风格 |
| 5 | SSE 流式解析器 | `src/inject/streaming-tool-parser.ts` | 核心算法已从 deepseek++ 等价移植（增量扫描+跨块保留未闭合标签尾部+JSON参数解析） |
| 6 | 工具记录数据结构 | `src/shared/tool-record.ts` | 新建统一类型文件，对齐 deepseek++ 的 ToolCall/ToolResult/ToolCallRecord 结构，含 summarizeToolResult 工具函数 |
| 7 | 请求增强 | `src/inject/main-world-interceptor.ts` | 工具提示词注入、工具结果回填、请求头过滤已实现；deepseek++ 的记忆/技能注入 studio 暂不需要 |

### 构建产物
- `src-tauri/inject/entry.js` — 125.8kb（含 WASM base64 + 工具卡片 UI + 提示词）

### 不移植的模块（合理排除）
- **MCP 工具控制器** — Chrome 扩展特有，Tauri 环境有自己的工具执行方式
- **沙箱运行器** — Chrome offscreen 沙箱，Tauri 直接用 Node.js child_process
- **记忆系统** — studio 暂不需要跨会话记忆
- **技能系统** — studio 暂不需要本地技能激活
