# ㊿-c-补⑧「memory_save 轮首抢跑」提示词四处改 · 真机复验报告
<!-- 历史快照：内引路径/行号为当时状态（0a9c4b41 版），不作活锚 -->

## 0. 结论
**PASS**。判据分层：提示词层（格A，确定性）真机请求体 8 项检查全中；行为层（格B，观测）两会话 memory_save 零出现、记忆库零写入，不作「永不再抢跑」的保证；产物面装版 entry.js 与仓库逐字相等、新文本转义锚全在；独立窄面 6 件 61/61＋tsc 绿；仓外负控两道靶心全中（②红／①红）。出资人侧挂账两件不变，其中「熔断 notice」本格拿到 ㊿-c-补⑥ terminate 透传层真机样本（见 §8-1），fuse notice 层仍未触发。

## 1. 冻结锚（复验前现算）
- HEAD `1fe14a0`（v0.14.33 抬号批）；修复提交 `94f7eb3`（㊿-c-补⑧ 四处改，PM 复核采信）。
- `src/inject/main-world-interceptor.ts` 251,423 B／4,408 行／blob16 `0a9c4b412215e4b8`（＝PM 交卷锚，全程未动）。
- 新测试件 `tests/desktop/memory-firstshot-prompt.test.ts` blob16 `91df6c28…`（PM 采信锚，本次未动）。
- 仓库 `src-tauri/inject/entry.js` 483,982 B／blob16 `775a863036901c36`／sha8 断形态 `55 3A 83 10 DB E3 3F 14`（v0.14.33 版，版本串 0.14.33 烘入）。
- 装版五值：`%LOCALAPPDATA%\DeepSeek++ Studio\deepseek-studio.exe` 15,549,952 B／FileVersion 0.14.33／mtime 11-25 03:19:24；装版 entry.js 483,982 B blob16 与仓库**逐字相等**（无混血）；装版 main.mjs 841,923 B sha8 断形态 `D1 A0 5C EF 8B 55 D0 0B`。
- 实例（起窗前现读）：装版 appPid 27728／宿主 node 27540（命令行含 `host\main.mjs`）／8760 True（装版持有）；dev 树 0。
- dev 窗（我另起，装版全程不碰）：tag v0.14.33，exe `src-tauri\target\debug\deepseek-studio.exe` 24,179,712 B／mtime 03:29:14／FileVersion 0.14.33／devStringHit=1／blob16 `0357f95c59f47a21`，appPid 11588，8761+9222；dev 宿主＝`node --require tsx\preflight src/api/dev-main.ts`（20596）＋tsx 包装层（20980，非宿主本体）。

## 2. 格A 提示词层（真机，dev 窗 CDP 9222 抓 `/api/v0/chat/completion` 请求体）
驱动＝CDP 真实输入（逐字符键盘）→ 页面真实 POST。请求体**顶层键**为 `chat_session_id/parent_message_id/model_type/prompt/ref_file_ids/…`，提示词在 `prompt` 字符串字段（非 messages 数组——首版匹配式按猜测路径全假阴性，读真件后修正，见 §7-2）。

q1（出资人原句「当前可用的 skill 和 mcp 有哪些」）与 q2（文件类问题）两会话，`prompt` 字段 8 项检查**双会话全 true**：
- `noMemSaveTagInPrompt`：请求体无 `<memory_save>` 示例标签 ✓
- `searchFilesExampleIn`：新中性示例 `<search_files>{"operation":"list","root":"E:/Users/name","limit":10}</search_files>` 在位 ✓
- `oldMemSaveExampleGone`：旧示范骨架（`"name":"测试"`／`"name":"用户角色"`）无残留 ✓
- `capItem3Restricted`：「仅当用户明确说“记住 / 记一下 / 别忘了”时才调用 memory_save」在位 ✓
- `oldCapItem3Gone`：旧第三条宽松措辞（「保存用户身份、偏好、技术栈、项目决策等跨会话信息」）不在 ✓
- `hardRuleIn`：记忆保存规则段硬规则（当时 L1535 行）在位 ✓
- `catalogLineRestricted`＋`catalogRestrictedCount=1`：请求体只含首段目录一枚（续跑目录 `TOOL_CATALOG_TEXT` 仅续跑轮注入，两枚一致性由格③单测层坐实）✓
- `sysFound=true`（解析成功，非对 raw body 的碰运气匹配）

行号锚（0a9c4b41 版当时盘面）：示例段 L1501-1506、扩展能力第三条 L1532、记忆规则硬规则 L1535、首段目录 memory_save 行 L1551、续跑目录 memory_save 行 L1569；测试件三格在 L39（①）／L47（②）／L56（③）。

## 3. 格B 行为层（观测口径，非全层保证）
取证件＝dev 配置根 `~/.config/deepseek-studio/storage.json` 事件流（测试窗新段按字节偏移截取）＋`memories.db` 副本法计数（`node:sqlite` readOnly）。
- **q1**：事件流 `user-message → 12×(mcp_call tool-start/tool-result) → 3×text`；memory_save 字面 **0 枚**；首枚工具＝mcp_call（非 memory_save）。
- **q2**：事件流 `user-message → local_file_stat ×2 → shell_exec ×4 → search_files ×2 → python_exec ×2 → final-answer`；memory_save 字面 **0 枚**；首枚工具＝local_file_stat。
- **memories.db 前后计数不变**：`memories=2 / memory_log=3 / memory_candidates=0`（q1、q2 两会话各测一次）⇒ 记忆库零写入。
- 口径声明：行为层是「两会话未再抢跑」的观测证据；提示词修复是否把抢跑概率压到 0 不能由两会话定论，出资人侧目检挂账不变。

## 4. 装版产物面（正式 NSIS 安装＝合法真机路径）
装版 entry.js 与仓库 blob16 逐字相等（`775a863036901c36`）＝无混血；装版无 9222 CDP，不能在装版触发新会话，机制层由 dev 窗坐实、装版本体由产物面＋§4 锚计数坐实（与 ⑦ 同口径）：
- 转义形态锚计数（esbuild 中文=大写 `\uXXXX`）：限定语「仅限用户明确要求时调用」＝**2 枚**（两枚目录行）；新 search_files 示例＝1 枚；旧 memory_save 示范骨架（`"type":"user","name":`）＝**0 枚**（残留清零）；硬规则锚＝1 枚；「才调用 memory_save」＝2 枚（扩展能力第三条＋硬规则段）。

## 5. 独立窄面（我侧自跑，不认 PM 绿）
真树 vitest 6 件：`memory-firstshot-prompt`（新件 3 it）＋`m15-tool-name-set`＋`memory-tool-boundary`＋`tool-contract-model-surface`＋`m15-head-ownership`＋`m15-byte-budget` ⇒ **6 件 61/61 EXIT=0**；`npx tsc --noEmit` 整树 **EXIT=0**。全量闸归 PM（GATE#128/#129 已绿在案）。

## 6. 仓外负控（`E:\NAS\negctl-v01433-memory8`，最小拷贝集＝整 src＋tests＋vitest.config.ts＋package.json＋tsconfig.json＋node_modules junction，全绝对路径）
- 干跑（未变异）：6 件 61/61 EXIT=0（日志 `logs/negctl-memory8-dryrun.log`）。
- **变异A**：L1532 第三条改回旧宽松措辞（`- 长期记忆（保存用户身份、偏好、技术栈、项目决策等跨会话信息）`）⇒ 格②「扩展能力收紧」**红**（1 failed | 2 passed，EXIT=1）；两道证：副本 blob16 变前 `0a9c4b41…`→变后 `3b2d9eca…`，真树 blob16 仍 `0a9c4b41…`（未动），退出码与输出同读。
- **变异B**：L1505 示例换回旧 memory_save 示范 ⇒ 格①「示例段无 `<memory_save>`」**红**（EXIT=1）；两道证：副本 blob16 `57f7c086…` vs 真树 `0a9c4b41…`（未动）。
- 负控树**留变异B态**；真树 `git status --porcelain` 净。

## 7. 验收席自认清单（本窗我犯的错，如实记录）
1. **devStringHit 探针 bug**：`$s=[Text.Encoding]::Latin1.GetString($s)` 把变量传给自己（null）⇒ .NET 对 null 当空串读 0 枚，误报「dev 壳被重烘成默认壳 devStringHit=0」，据此误杀了第一个 dev 窗 job 重起一轮。修正探针（`GetString($b)`）现读＝1，壳本来就是 dev 壳。损失＝一轮起窗时间，无数据污染。
2. **匹配式先写后验**：首版脚本对 raw body 直接 `includes()`＋猜 `p.messages` 路径 ⇒ `searchFilesExampleIn=false`／`sysFound=false` 双假阴性（请求体内引号被 `\"` 转义＋提示词在顶层 `prompt` 字段）。读真件形态后改式复跑全绿——AGENTS 五族（枚数形态／行首锚／真件先行）又一枚复发，本条已按「先读真件再写式」执行。
3. **运算符优先级与引号坑×4**：`console.log('…' + t.split(x).length - 1)` 两枚出 NaN（字符串加法先于减法）；PS 内联 `node -e` 中文引号转义 ParserError 两次（改脚本文件跑）；`Get-Content|Measure-Object -Line` 读 4,228 行（真值 4,408，read 工具 4,408 为准）。均不影响结论，已复取。
4. 全程未碰装版 27728/27540/8760 与装版资源目录；dev 配置根收工复同（config `C6B5F30A`／mcp-servers `2D5E191F`，mtime 未前进）。

## 8. 观察（不属本格判据，报 PM 参考，不代裁）
1. **㊿-c-补⑥ terminate 透传层真机样本**：q1 事件流 `duplicate-tool-signature` 拒绝的 tool-result 原文携带 `"terminate": true`（storage 真件截取）⇒ terminate 透传到 tool-result 在 dev 窗真机坐实一枚。出资人挂账的 **fuse notice 层本会话未触发**（无 fuse 事件；12 枚 mcp_call 拒绝码为 invalid-tool-json/duplicate-signature 混合，未凑满同轮同码 3 次熔断线），目检挂账维持。
2. **同类缺陷候选（建议开卡，不代裁）**：mcp_call 目录行参数说明为占位式（`serverId、tool、args（参数对象）`），模型把中文占位（「服务器名／工具名／具体参数对象」）原样当 JSON 参数 ⇒ q1 连发 12 枚 invalid-tool-json mcp_call。与 ㊿-c-补⑧ 同族（提示词自身在教模型照抄）——是否新卡由 PM 裁。
3. q1 final-answer 列「16 个技能」vs dev 基线 12 枚全启用（⑦ 域读数，非 ⑧ 判据，仅记录）。

## 9. 收工四项
① `deepseek-studio.exe` 进程数＝**1**（装版 27728，原样保留）；② 命令行含 `host\main.mjs` 宿主 node＝**1**（装版 27540），dev-main.ts＝0、tsx 包装＝0；③ 8760＝**True（装版持有）**／8761＝False／9222＝False（可连性形态现读）；④ 两棵 sidecar 日志根：dev 根 `%APPDATA%\deepseek-studio\logs` 根 mtime 03:29:22／最新 `sidecar-1795548562656.log` 03:29:23（dev 窗会话期内）；装版根 `%APPDATA%\com.deepseek.studio\logs` 根 mtime 03:22:59／最新 `sidecar-1795548179044.log` 03:23:01（我会话开始前的旧值，未前进）。

## 10. 取证件索引
- 驱动脚本：`logs/verify-memory8-cdp.mjs`（q1/q2 编排，CDP 真键盘输入＋请求体解析＋storage 新段＋memories.db 副本计数）；`logs/verify-memory8-{q1,q2}.json`（含 body 全文、事件段原文、前后计数）。
- 解析：`logs/verify-memory8-parse.mjs`（工具序列／memory_save 枚数）、`logs/verify-memory8-ctx.mjs`（terminate 上下文）、`logs/verify-memory8-installed-probe.mjs`（装版产物面转义锚）。
- 负控：`E:\NAS\negctl-v01433-memory8`（留变异 B 态）、干跑日志 `logs/negctl-memory8-dryrun.log`。
- dev 配置备份：`logs/backup-v01433-devconfig/`（收工复同 C6B5F30A／2D5E191F）。
