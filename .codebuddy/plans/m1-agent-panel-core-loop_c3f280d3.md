---
name: m1-agent-panel-core-loop
overview: 实现 deepseek-studio M1「智能体面板核心闭环」：新增宿主 AgentLoop（多步工具循环）、可插拔 ModelEngine（MVP 用网页引擎驱动 chat.deepseek.com）、Trae 式对话面板 UI、「打开文件夹」工作区选择、三档权限切换与审批弹窗，复用 v0.5 既有 file/shell/policy/audit 能力，实现自然语言多步自主执行（读文件/写文件/跑命令）。
design:
  architecture:
    framework: html
  styleKeywords:
    - 深色开发者工具
    - 高信息密度
    - 品牌蓝点缀
    - 状态灯语义色
  fontSystem:
    fontFamily: 思源黑体
    heading:
      size: 14px
      weight: 600
    subheading:
      size: 12px
      weight: 500
    body:
      size: 13px
      weight: 400
  colorSystem:
    primary:
      - "#4D6BFE"
      - "#6E8BFF"
    background:
      - "#0F1115"
      - "#171A21"
      - "#1E222B"
    text:
      - "#E6E8EC"
      - "#9AA3B2"
    functional:
      - "#22C55E"
      - "#EAB308"
      - "#EF4444"
todos:
  - id: policy-three-tier
    content: 扩展 policy.ts 三档（新增 workspace 档、默认 auto）与 MutableWorkspaceContext 可变代理，desktop-host 暴露 setPolicyMode/setWorkspaceRoot 并持久化配置，补单测
    status: completed
  - id: file-stat-contract
    content: file.ts 新增 file.stat 能力、tool-definitions 登记、FILE_TOOLS 纳管、tool-contract 映射 local_file_stat 改指 file.stat，更新相关测试
    status: completed
  - id: engine-agent-loop
    content: 实现 ModelEngine 接口+WebEngine（insert/send/稳定检测/看门狗/纠偏）与 agent-loop.ts 状态机（max_steps/停止/续跑），page-runtime 透出 onToolCall 事件，拦截器哨兵关键词，ApiEngine 占位
    status: completed
  - id: agent-channel-server
    content: desktop-host 装配 agent facade，api/server 增加 /agent 页面与静态资源、WS /agent-ws 通道与选目录（PowerShell FolderBrowserDialog）端点
    status: completed
    dependencies:
      - engine-agent-loop
      - policy-three-tier
  - id: panel-ui-window
    content: 实现面板 UI（顶栏/会话流/输入区/权限切换器）并接入 esbuild 打包，main.rs 增加第二个 Tauri 窗口加载 /agent
    status: completed
    dependencies:
      - agent-channel-server
  - id: tests-acceptance
    content: 补 agent-loop/policy/工作区/file.stat/契约单测，npm test 与 typecheck 全绿，tauri:dev 实测三场景（读文件总结/写文件/跑命令+三档切换+审批弹窗）
    status: completed
    dependencies:
      - panel-ui-window
---

## 产品概述
把 deepseek-studio 升级为 Trae 式编码智能体的 M1（核心闭环）：新增专用「智能体对话面板」，用户在面板中用自然语言下指令，宿主驱动多步循环，自动驱动 chat.deepseek.com 作为模型引擎、解析工具调用、经授权链执行文件读写与命令，并把结果回填模型直至任务完成。全程无需用户敲命令。

## 核心功能
- 智能体面板（独立 Tauri 窗口）：会话流展示（用户/助手/工具执行卡片）、输入框、发送、停止按钮、工作区与权限档位状态栏
- 「打开文件夹」：原生目录选择对话框（PowerShell FolderBrowserDialog，宿主侧实现）+ 手动路径输入兜底，选定即权限边界，持久化到配置
- 权限三档随时切换：①仅工作区（shell/越界一律拒绝，新增档位）②风险才审批（默认）③完全放开；仅影响 file.*/shell.*，治理红线（argv 直执行、fail-closed）不变
- AgentLoop：自然语言 → 模型回复含工具标签 → 执行 → 结果回填 → 自动续跑，直至产出最终回答；护栏：max_steps=15/回合、单步 120s 看门狗、随时停止（上下文保留）
- WebEngine：复用现有注入拦截器（工具说明注入 + 结果回填 + 流式标签解析）驱动 chat.deepseek.com；解析失败自动纠偏重试 1 次；ApiEngine 仅留接口占位（M3）
- MVP 工具集：file.read / file.write / file.list / file.stat（新增）/ shell.exec，全部走既有授权链（grant → 治理闸 → 三档策略 → 同意闸 → 审计）
- M1 审批形态为简单允许/拒绝弹窗（diff 卡片属 M2）
- 验收：打开文件夹 → 「读取 xxx 并总结」「新建文件写入…」「运行 npm test」三场景全流程自主多步完成


## 技术方案

### 执行侧核心决策：复用拦截器执行链，宿主只做编排
工具执行不走「宿主重新解析」，而是复用已验证的 v0.6 链路：页面内拦截器流式解析工具标签 → ws 反向投递 → hub 执行（完整授权链+三档策略+同意闸）→ 结果存入拦截器 pending → 下一次出站请求自动回填。AgentLoop 仅编排「发消息 → 等完成 → 是否有工具调用 → 发续跑指令」。这样消除双重执行风险，改动半径最小。
- 首次运行时 chat-insert/chat-send 会弹一次同意框，勾选「本会话允许」后不再打扰（复用 sessionAllowlist 机制，不绕过治理）
- 面板消息带 `【Studio Agent】` 哨兵前缀，拦截器 hasToolIntent 据此必定注入工具能力说明
- 完成检测：轮询 chat-read，快照连续 2 次稳定（≥1.5s）即认为回复结束；120s 看门狗兜底

### 架构
```mermaid
graph LR
  P[智能体面板窗口 /agent] -- WS /agent-ws --> AC[AgentChannel]
  AC --> AL[AgentLoop 状态机]
  AL -- chat-insert/send/read 经 hub.dispatch --> MW[chat.deepseek.com 主窗口+拦截器]
  MW -- tool-call ws --> HUB[PageRuntimeHub]
  HUB --> IT[invokeTool 完整授权链]
  IT --> POL[三档策略+同意闸+审计]
  POL --> CAP[file.*/shell.exec 宿主能力]
  AL -- onToolCall 事件 --> AC
```

### 目录结构
```
e:/NAS/deepseek-studio/
├── src/host/policy.ts                # [MODIFY] 新增 workspace 档；默认档改 auto；补判定矩阵
├── src/host/workspace.ts             # [MODIFY] 新增 MutableWorkspaceContext 可变代理
├── src/host/desktop-host.ts          # [MODIFY] setPolicyMode/setWorkspaceRoot；暴露 agent facade；创建 AgentLoop
├── src/host/page-runtime.ts          # [MODIFY] onToolCall/onToolResult 事件回调透出
├── src/host/tool-definitions.ts      # [MODIFY] 登记 file.stat
├── src/host/agent-loop.ts            # [NEW] 状态机：发送/等待/续跑/停止/max_steps/看门狗
├── src/host/engine/model-engine.ts   # [NEW] ModelEngine 接口 + ApiEngine 空实现占位
├── src/host/engine/web-engine.ts     # [NEW] WebEngine：insert/send/轮询稳定检测/纠偏重试
├── src/host/agent-channel.ts         # [NEW] WS /agent-ws：面板消息与事件推送
├── src/api/server.ts                 # [MODIFY] GET /agent 页面（内嵌会话令牌）、/agent.js 静态、WS upgrade 路由
├── src/api/main.ts                   # [MODIFY] agentMaxSteps 等配置项
├── src/capabilities/file.ts          # [MODIFY] 新增 file.stat（size/mtime/isDir）
├── src/shared/tool-contract.ts       # [MODIFY] local_file_stat → file.stat
├── src/inject/main-world-interceptor.ts # [MODIFY] hasToolIntent 增加 Studio Agent 哨兵与「工作区」关键词
├── src/ui/agent.html / agent-panel.ts / agent-panel.css # [NEW] 面板 UI（原生 TS，esbuild 打包）
├── esbuild.inject.mjs                # [MODIFY] 增加 agent-panel 打包入口
├── src-tauri/src/main.rs             # [MODIFY] 新增第二个窗口加载 http://127.0.0.1:8756/agent
└── tests/                            # [NEW/MODIFY] policy workspace 档、agent-loop 状态机、可变工作区、file.stat、契约映射
```

### 关键接口
```ts
interface ModelEngine {
  readonly name: 'web' | 'api';
  health(): Promise<{ ok: boolean; reason?: string }>;
  /** 发送一条消息并等待模型回复结束；返回最终文本与期间发生的工具调用记录。 */
  send(text: string): Promise<{ content: string; toolCalls: ToolCallRecord[] }>;
}

interface AgentFacade {
  sendMessage(text: string): Promise<void>;  // 异步推进循环，事件经 channel 推送
  stop(): void;
  setWorkspaceRoot(path: string): Promise<{ ok: boolean; error?: string }>;
  setPolicyMode(mode: PolicyMode): void;
  pickFolder(): Promise<string | null>;      // PowerShell FolderBrowserDialog
}
```

### 实施要点
- 可变工作区：file/shell 能力在创建时捕获 workspace 引用，引入 delegate 代理对象使 setWorkspaceRoot 热生效，并同步持久化 workspaceRoot 到 ~/.config/deepseek-studio/config.json
- /agent 页面内嵌当前 API 令牌：与既有威胁模型一致（本地进程本可读 config.json），CORS 仍 fail-closed 仅回环
- 双重执行防护：AgentLoop 不自行解析标签，仅依据 hub 的 tool-call 事件计数与决策续跑
- 完成检测用「文本稳定 + 看门狗」启发式，chat-read 角色推断较弱属已知限制，M1 以面板展示最终回答为主
- 性能：轮询间隔 1.5s，工具执行串行（沿用 maxConcurrent=1）；无新增重依赖
	

## 设计风格
面板采用深色开发者工具风格（对标 Trae/Cursor）：深色底 + DeepSeek 品牌蓝点缀，信息密度高、层级清晰。单窗口三段式布局：顶栏（工作区路径+打开文件夹按钮+三档权限切换器+连接状态灯）、中部会话流（用户消息右对齐蓝底、助手回答左对齐深灰底、工具调用为紧凑卡片显示工具名/参数摘要/成功失败徽章）、底部输入区（多行输入+发送+停止按钮，运行中发送禁用、停止高亮）。权限切换器为分段控件，当前档位高亮并配状态灯（绿=仅工作区/黄=风险审批/红=放开）。全部原生 TS + CSS，无框架。
