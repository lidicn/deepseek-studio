# ㊿-c-补⑨「mcp_call 目录行占位参数改可执行形态」真机复验报告
<!-- 历史快照：内引路径/行号为当时状态（12ef2906 版），不作活锚 -->

## 0. 结论
**PASS**。判据分层：提示词层（格①②③，确定性）真机请求体 7 项检查三会话全中；行为层（格④，观测）q4 真 mcp_call 成功调用 `af_health`（ok=true）且 invalid-tool-json **0 枚**（补⑧ 现场 12/12 的对照，显著下降坐实）、q3 答案自述 `tv_zap {}`→schema 报错亦为合法 JSON；产物面装版 entry.js 与仓库逐字相等、新锚全在旧占位清零；独立窄面 8 件 78/78＋tsc 绿；仓外负控双靶心全中（撤首段目录行⇒①②红、callway 改回中文占位⇒④红）。

## 1. 冻结锚（复验前现算）
- HEAD `62effb3`（v0.14.34 抬号批）；修复提交 `1ddc3c6`（㊿-c-补⑨ 四处：目录行×2＋callway＋新测试件）。
- `src/inject/main-world-interceptor.ts` 251,820 B／4,408 行／blob16 `12ef2906a727687b`（＝UI 交卷锚，全程未动）。
- `tests/desktop/mcp-call-catalog.test.ts` 4,358 B／85 行／blob16 `12e0f4bd7d5ee285`；`tests/desktop/catalog-budget.test.ts` 15,279 B／291 行／blob16 `854a793e0ea0c1dd`。
- 仓库 `src-tauri/inject/entry.js` 484,610 B／blob16 `2ffd549b66e1d10f`。
- 装版五值：exe 15,549,952 B／FileVersion 0.14.34／mtime 05:38:44；装版 entry.js 484,610 B blob16 与仓库**逐字相等**（无混血）、mtime 05:32:36；main.mjs 841,923 B sha8 断形态 `D1 A0 5C EF 8B 55 D0 0B`。
- 实例（起窗前现读）：装版 appPid 28516／宿主 node 30664（命令行含 `host\main.mjs`）／8760 True；dev 树 0。
- dev 窗（我另起，装版全程不碰）：tag v0.14.34，exe `src-tauri\target\debug\deepseek-studio.exe` 24,179,712 B／mtime 05:48:00／FileVersion 0.14.34／devStringHit=1／blob16 `80a70826bf00ce86`，appPid 32232，8761+9222；dev 宿主＝node+tsx preflight（12596），包装层 17716。

## 2. 格①②③ 提示词层（真机，dev 窗 CDP 9222 请求体 `prompt` 字段）
驱动＝CDP 真实键盘输入→页面真实 POST `/api/v0/chat/completion`。三会话（q3 首跑、q3 重试、q4）解析后的 `prompt` 串 7 项检查**全 true**：
- `mcpCallLineNew`：mcp_call 目录行带可执行形态＋来源说明＋最小示例 `{"serverId":"example","tool":"example","args":{}}` 在位（首段目录 1 枚；两份目录逐字一致由单测格②坐实，卡面口径）；
- `oldLineGone`：旧占位行「参数：serverId、tool、args（参数对象）」清零 ✓；
- `callWayNeutral`：MCP 块「调用方式」中性示例 `<mcp_call>{"serverId":"example","tool":"example","args":{...}}</mcp_call>` 在位 ✓；
- `zhPlaceholderGone`：`"服务器名"`／`"工具名"` 中文字面清零 ✓；
- `mcpBlockIn`：MCP 工具块在请求体（dev 宿主加载 TVPilot 30＋AutoForge 39 共 69 工具）✓。

行号锚（12ef2906 版当时盘面）：首段目录 mcp_call 行 L1554、续跑目录 L1572（逐字同串）；「调用方式」行在 `formatMcpToolsBlock` 内约 L1642；测试件 4 格在 L40（①）／L52（②）／L63（③）／L72（④）。

## 3. 格④ 行为层（观测口径，不冒充全层）
取证件＝dev 配置根 `~/.config/deepseek-studio/storage.json` 事件流（会话新段按字节偏移截取）。
- **q4（AutoForge 会话）**：事件流 `mcp_list ×2 → mcp_call ×2 → final-answer`；mcp_call 参数真件 `{"serverId":"AutoForge","tool":"af_health","args":{}}`（真实 serverId＋真实工具名＋最小 args）⇒ tool-result **ok=true**（143ms，返 AutoForge v1.30.18 health 数据）；**invalid-tool-json 0 枚**（补⑧ 现场 12/12 的对照：照抄中文占位的病根已除）。
- **q3（TVPilot 会话）**：首跑遇上游 `body-error-40303`（服务器暂时无法访问，自动重试 2 次仍失败）——上游瞬时不可达，非代码缺陷，该跑作废；重试跑模型 final-answer 自述「mcp_list 30 工具清单＋mcp_call 调 `tv_zap` args={}→失败：channel 不能为空（schema 校验）」——亦为合法 JSON 入参（事件流新段只截到 final-answer，工具事件在 storage 同会话键内原位更新未入新段，此格按答案自述＋q4 硬事件双读，如实注记）。
- 口径声明：行为层是「两会话未再现照抄占位」的观测；「永不再发 invalid-tool-json」不作全层保证。

## 4. 装版产物面（正式 NSIS 安装＝合法真机路径）
装版 entry.js 484,610 B blob16 `2ffd549b66e1d10f`＝仓库逐字相等（无混血）；装版无 9222，不能在其上触发新会话，机制层由 dev 窗坐实、装版本体由产物面锚坐实（补⑧ 同口径）。转义形态锚现读（esbuild 中文=大写 `\uXXXX`，先读真件形态再写匹配式）：
- 最小示例 JSON（纯 ASCII）＝**2 枚**（两份目录行）；「调用方式」中性行（含 `{...}`）＝1 枚；来源说明锚「mcp_list 返回的该服务器工具名」＝2 枚；
- 旧占位清零：「args（参数对象）」骨架 0 枚、「服务器名」0 枚、「工具名」0 枚。

## 5. 独立窄面（我侧自跑，不认他人绿）
真树 8 件 vitest：`mcp-call-catalog`（新件 4 格）＋`catalog-budget`＋`m15-tool-name-set`＋`m15-head-ownership`＋`m15-byte-budget`＋`tool-contract-model-surface`＋`memory-tool-boundary`＋`memory-firstshot-prompt`（补⑧ 回归）⇒ **8 件 78/78 EXIT=0**；`npx tsc --noEmit` 整树 **EXIT=0**。全量闸归 PM（GATE#130/#131 已绿在案）。

## 6. 仓外负控（`E:\NAS\negctl-v01434-mcp9`，最小拷贝集＝整 src＋tests＋vitest.config.ts＋package.json＋tsconfig.json＋node_modules junction，全绝对路径）
- 干跑（未变异）：8 件 78/78 EXIT=0（日志 `logs/negctl-mcp9-dryrun.log`）。
- **变异A**（首段目录行 L1554 单撤回旧占位「参数：serverId、tool、args（参数对象）」，续跑目录不动）⇒ 格①**红**＋格②**红**（两份脱钩）、③④ 绿（2 failed/2 passed，EXIT=1）；两道证：副本 blob16 `abd78b6f…` vs 真树 `12ef2906…`（未动），退出码与输出同读。
- **变异B**（仅「调用方式」行改回「服务器名/工具名」中文占位）⇒ 格④**红**单靶心（1 failed/3 passed，EXIT=1）；两道证：副本 blob16 `fdaf9fc8…` vs 真树 `12ef2906…`（未动）。
- 负控树**留变异B态**；真树 `git status --porcelain` 净。

## 7. 验收席自认清单（本窗我犯的错，如实记录）
1. **变异B 首做叠态**：第一发变异脚本因 PS 解析错整体未执行，其后的「还原＋变异B」误叠在变异A态上（得 3 failed，非净靶心）——发现后还原干净副本、只撤 callway 行重做（`fdaf9fc8…`，1 failed 净靶心）。叠变那发作废，未写入结论。
2. **`$a[-1]` 负索引事故**：首枚变异脚本 callway 行定位失败（整行比对 vs 行内子串）后写 `$a[$i3]=$oldCw`（$i3=-1）＝PowerShell 负索引落到**末行**，把副本文件末行改坏（transform 报错的红是伪靶心）——还原后改「行内 Contains 定位＋整文件字符串替换（不动行尾）」重做，教训：副本行编辑只认子串定位＋写后 blob16 双证。
3. **匹配式先写后验×1**：驱动脚本首版对 `Uint8Array` 直接 `.matchAll`（TypeError 崩在格A之后），改先 `toString('utf8')` 再跑——AGENTS 五族同型（0 枚/报错先查形态）。
4. **上游 40303 窗口**：q3 首跑被上游瞬时不可达挡住（自动重试 2 次仍失败），未硬凑证据、按「该跑作废＋重试」处置，行为格以 q4 硬事件＋q3 答案自述双读并如实注记。
5. 全程未碰装版 28516/30664/8760 与装版资源目录；dev 配置根收工复同（config `C6B5F30A`／mcp-servers `2D5E191F`，mtime 未前进）。

## 8. 观察（不属本格判据，报 PM 参考，不代裁）
1. q4 证明修复版真机可完成「mcp_list→mcp_call 真实工具」全链（`af_health` ok=true）——MCP 桥真机可用性一枚样本（非本卡判据，供 ㊿-c-补⑤ MCP 刷新验收记录参考）。
2. 出资人侧挂账两件（fuse notice 目检、装版 2-启用基线目检）不变；本卡未触发 fuse。

## 9. 收工四项
① `deepseek-studio.exe` 进程数＝**1**（装版 28516，原样保留）；② 命令行含 `host\main.mjs` 宿主 node＝**1**（装版 30664），dev-main.ts＝0、tsx 包装＝0；③ 8760＝**True（装版持有）**／8761＝False／9222＝False（可连性形态现读）；④ 两棵 sidecar 日志根：dev 根 `%APPDATA%\deepseek-studio\logs` 根 mtime 05:48:10／最新 `sidecar-1795556890735.log` 05:55:19（dev 窗会话期内）；装版根 `%APPDATA%\com.deepseek.studio\logs` 根 mtime 05:43:53／最新 `sidecar-1795556633244.log` 05:43:54（装机时刻旧值，未前进）。

## 10. 取证件索引
- 驱动：`logs/verify-mcp9-cdp.mjs`（q3/q4 编排：CDP 真键盘＋prompt 字段解析＋storage 新段＋工具序列计数）；`logs/verify-mcp9-{q3,q4}.json`（含 body 全文、checks、事件段原文、mcp_call 参数真件）；`logs/verify-mcp9-{parse,ctx}.mjs`（事件序列／参数／答案原文解析）；`logs/verify-mcp9-reload.mjs`（页面刷新清错误态）。
- 装版产物面：`logs/verify-mcp9-installed-probe.mjs`（锚 2/1/0/0/0/2）。
- 负控：`E:\NAS\negctl-v01434-mcp9`（留变异B态）、干跑日志 `logs/negctl-mcp9-dryrun.log`、变异脚本 `logs/verify-mcp9-mutB.mjs`。
- dev 配置备份：`logs/backup-v01434-devconfig/`（收工复同 C6B5F30A／2D5E191F）。
