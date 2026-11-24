<!-- 历史快照：内引路径/行号为 2026-11-24/25 取证当时状态（HEAD a38438b / 修复在 c5d74b7），不作活锚 -->
# ㊿-c-补⑦「## 可用技能」注入块 · 真机复验报告（Verify 独立验收）

**批次**：㊿-c-补⑦（`main-world-interceptor.ts` 新增「## 可用技能」块：只列已启用技能＋目录范围声明＋空态显式文案）
**结论**：**PASS**（四格真机坐实＋装版 product-level 无混血＋负控两靶心命中＋独立窄面；真机驱动用**并行 dev 窗**，装版 26544/8760 全程不碰，如实注记口径偏差）
**冻树**：HEAD `a38438b`（v0.14.32，`c5d74b7` 修复的抬号批），工作树 CLEAN
**产物双锚（判据基准＝bytes＋blob16，标对 HEAD a38438b 这版）**：`entry.js` 483,499 B／blob16 `73659ffcd10a0ae9`；`main-world-interceptor.ts` 251,170 B／blob16 `0b95dd96a6e9170d`；`available-skills-block.test.ts` 5,695 B／blob16 `c0e7067b6ee08915`
**装版**：`%LOCALAPPDATA%\DeepSeek++ Studio\deepseek-studio.exe` 15,549,952 B／FileVersion 0.14.32；**装版 entry.js 483,499 B＝仓库逐字同（sha256 前 8 字节 `73EE277B` IDENTICAL）、host 同** ⇒ **无混血**，㊿-c-补⑦ 块已在装版。
**实机驱动**：装版仅监听 8760（**无 9222 CDP**，无法在装版驱动新会话）⇒ 按卡面「CDP 9222＋WS 8761」起**并行 dev 窗**（appPid 23792，8761＋9222，identifier `com.deepseek.studio.dev`、profile `~/.config/deepseek-studio`，**不占装版 8760、不碰装版 26544/资源文件**）；取证件 `logs/verify-skill7-cdp.mjs`／`-toggle.mjs`＋`verify-skill7-{baseline,oneOff,allOff}.json`（可重跑）。

## 1. 修复机制（我现读，行号当时盘）
`formatAvailableSkillsBlock`（约 L1753-1767）：`enabled = currentSkills.filter(s => s.enabled !== false)`（约 L1754，与 `selectExplicitSkills` 同口径缺键＝启用）；块首 `## 可用技能（Studio 技能唯一权威清单）`＋**目录范围声明**（约 L1757：只认 `~/.agents/skills` 与 `<configDir>/skills`，点名排除 `~/.claude/skills`、`~/.codex/skills`，禁 `shell_exec/python_exec` 扫盘）；**空清单显式「当前没有已启用的技能。」**（约 L1760，不省略）；逐枚 `- <id>（<name>）— <description>｜SKILL.md: <path>`。挂载 `buildCapabilityPrompt`（约 L1774-1785）**无 if 守卫、每发送轮注入**（约 L1780，区别于 MCP 块的空省略）。`selectExplicitSkills`「点名才读」闸门（约 L1731-1733）一字未动。

## 2. 真机四格（dev 窗 CDP 9222 真实 chat 请求体＋WS 8761，不拿单测冒充）
dev 窗 `skill.list` 基线 **12 枚全启用、0 禁用**（dev 配置，与装版 11-禁用不同，见 §5 自认）。抓「问可用技能」请求体（`/api/v0/chat/completion`）：
| 态 | 请求体 len | 块首 | 目录范围声明 | 列枚数 | 空态文案 |
|---|---|---|---|---|---|
| 基线（12 启用） | 8507 | 有 | .agents/.claude/.codex 均在 | **12** | 无（有技能） |
| 关 adm-auditkit（11 启用） | 8279 | 有 | 均在 | **11**（该 skill 不在） | 无 |
| 全禁（0 启用） | 5486 | 有 | 均在 | **0** | **有「当前没有已启用的技能。」** |

- **格①（只报已启用）**：请求体 `## 可用技能` 块逐枚列 `SKILL.md:`＝12/11/0 随启用态增减，被关者不在 ⇒ 只报已启用。
- **格②（目录范围声明生效）**：块内 `.claude/skills`、`.codex/skills`（点名排除）＋ `.agents/skills`（在范围）＋「不要用 shell_exec/python_exec 扫盘」全在 ⇒ 正面格坐实。
- **格③（被禁不在清单）**：`skill.enabled.set adm-auditkit off` ⇒ 请求体块 12→11、该 skill 逐字不在。
- **格④（全禁显式答无）**：全禁 ⇒ 块 0 枚＋**显式「当前没有已启用的技能。」**（非省略、非空串）。

## 3. 装版 product-level（无混血＝㊿-c-补⑦ 已在装版）
装版 `entry.js` 483,499 B＝仓库 blob16 `73659ffc` 逐字同（sha256 前 8 字节 `73EE277B` IDENTICAL）、host 同；块标记 `.claude/skills`、`.codex/skills`、`.agents/skills` 在装版 entry.js（中文「可用技能／没有已启用」以 `\uXXXX` 大写转义进产物，按大写 hex 形态核＝在，非缺件）。装版 26544 在 8760、healthz ok、全程未关未碰。

## 4. 独立窄面（我侧现跑，非 UI 自测）
`npx vitest run tests/desktop/available-skills-block.test.ts`＝**4/4 passed EXIT=0**；`npx tsc --noEmit`＝**EXIT=0**。（全量闸归 PM，我零全量。）

## 5. 负控（仓外副本树 `E:\NAS\negctl-v01432-skill7`，全绝对路径＋node_modules junction）
未变异干跑 **4/4 绿**。两处单点变异（只改副本，各自独立）：
- **变异A（格②）**：摘目录范围声明（副本约 L1757 换成无目录名占位）⇒ **②「目录范围声明在位」红**（`expected … to contain '~/.agents/skills'`），①③④ 绿；1 failed/3 passed。
- **变异B（格③）**：空清单改 `return ''`（副本约 L1759-1760，模拟省略）⇒ **③「无启用⇒显式文案非空串」红**（`expected 0 to be greater than 0`＝块变空）＋②（空态子断言）连带红，①④ 绿；2 failed/2 passed。
- **两道证**：① 变异目标 vs 真实现——真树 interceptor blob16 `0b95dd96a6e9170d` 全程未动；副本变异A `4656ce19`／变异B `6ec7d318`（各已变）；② 退出码与输出同读（干跑 4/4 EXIT=0，A→②红、B→③红 EXIT=1）。真树 `git status --porcelain` 仅我域报告新件（零业务改动）。⇒ ㊿-c-补⑦ 两条不变式（目录范围声明必要、空态显式文案必要）各摘其一即红其格。

## 6. 收尾与纪律
dev 配置根 `~/.config/deepseek-studio`：格③④ toggle 后 `config.json` 单步写回复同 **SHA `C6B5F30A8E8E2606`**（`skill.list` 复回 12 启用），`mcp-servers.json` 基线 `2D5E191FF9459140` 未动。装版资源目录零碰、零拷开发树产物、装版 26544 未关。未做 commit/push。

## 7. 收工四项（收 dev 窗 23792 后读；装版 26544 保留）
① `deepseek-studio.exe`＝**1**（装版 26544，我的 dev 壳 23792 已退）；② 命令行含 `host\main.mjs` 宿主 node＝**1**（装版 6560）、dev 宿主 `dev-main.ts`＝**0**（已收净）；③ 8760＝True（装版持有，预期）／8761＝False／9222＝False；④ sidecar 根：装版根 mtime 23:52:35 未再前进、最新装版 sidecar 文件 23:52:39、dev 根 `~/.config/deepseek-studio/logs` absent。

## 8. 验收席自认清单（如实记录）
① **装版无 CDP，改并行 dev 窗驱动**：装版 26544 仅监听 8760、无 9222，无法在装版触发新会话；按卡面「CDP 9222＋WS 8761」起并行 dev 窗（identifier 分档不碰装版 8760/26544）驱动受控会话。卡面「装版在跑起不了 dev 窗」的顾虑与 ⑤/⑥ 实证（dev 走 8761+9222、装版走 8760 互不干扰）不符，我按可并行走。
② **格①基线偏差**：真机四格跑在 dev 窗（skill.list 12 启用），非装版基线（11 禁用⇒2 启用 ego-browser/media-search）——dev 与装版配置分档不同；机制（块＝已启用＋目录范围＋空态）在 dev 坐实，装版 2-启用基线由「装版 entry.js＝仓库（块已在）」＋**出资人侧目检**兜底（卡面已留此两件挂账）。
③ **首条 grep 误用字符串 `.Length`**（UTF-16 字符 482,749）当文件字节，实为 483,499 B（`Get-Item.Length`）；已用 Get-FileHash 复核 IDENTICAL，无混血坐实。
④ **卡面负控「④红」系笔误**：测试件 L20-21 口径为「摘范围声明⇒②红、空清单返空串⇒③红」，我按测试件执行（B 变异命中 ③＋② 空态子断言）。
