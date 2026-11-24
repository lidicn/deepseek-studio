# v0.14.32 发版说明

发布日期：2026-11-24（tag `v0.14.32`；本版修复**模型答「当前可用技能」时自扫盘、把非 Studio 管理的目录当可用技能报出、与设置矛盾**——补上注入层的「## 可用技能」权威清单块，只列已启用技能并显式声明目录范围）

## 这版修了什么

### 1. 模型报的「可用技能」与设置矛盾（`c5d74b7`）

**现象**：用户问「当前可用的技能有哪些」，模型的回答里 10 个技能**全部来自 `~/.claude/skills`（5）与 `~/.codex/skills`（6）**——这两个目录 Studio 从不扫描（技能只认 `~/.agents/skills` 与 `<configDir>/skills`），且其中多数已被设置禁用，与设置页面（启用仅 2 枚）直接矛盾。模型该轮工具调用为 `memory_save`×1、`mcp_list`×2、`python_exec`×6——**没有 `skill.list`**，模型工具目录里根本没有查询技能的入口，只能 `python_exec` 扫盘凑答案。

**根因**（两处都在**提示词的权威信息面**）：

- **模型侧没有查询技能的权威入口**：`## 可用工具`提示块只列内置工具＋MCP 工具，没有技能查询工具；
- **提示词里没有「可用技能清单」块**：既有 `formatExplicitSkillsBlock` 只注入用户**明确点名**的技能，用户没点名时返回空串 ⇒ 模型没有任何权威的「已启用技能」列表，只能扫盘。

**修复**（注入层单点，`src/inject/main-world-interceptor.ts`）：

- 新增 `formatAvailableSkillsBlock()`，**只列 `enabled !== false` 的技能**（缺键视为启用，与 `selectExplicitSkills` 同口径），逐枚带 `- <id>（<name>）— <description>｜SKILL.md: <path>`；
- **目录范围声明常带**：技能只认 Studio 管理的 `~/.agents/skills` 与 `<configDir>/skills`，点名排除 `~/.claude/skills`、`~/.codex/skills` 等非管理目录，明说不得扫盘找技能；
- **空清单不省略**：显式写「当前没有已启用的技能」，与 MCP 块的空省略语义区分；
- 挂进 `buildCapabilityPrompt` **每发送轮注入、无 `if` 守卫**（区别于 MCP 块与点名技能块）；`selectExplicitSkills` 点名闸门一字未动；
- 新文案若含 `C:/Users/<用户名>` 字面量会被 R2-08「源码与产物不得含本机用户路径」守卫拦下——范围声明文案写为「用户主目录」，源码与产物该字面量清零。

## 验证

- 全量闸 **exit=0**（GATE#126，1565.6s，18 步阻塞＋6 步信息），vitest **339 files／3769 passed／1 skipped**；双产物 freshness PASS（entry `47CB66A5`／host `D1A05CEF`）
- CI run **45412476417**（head `c5d74b7`）：success
- 新测试件 `tests/desktop/available-skills-block.test.ts` 四格：只含已启用／范围声明点名排除非管理目录／空清单与全禁均显式「没有」非空串／点名闸门回归且两块共存不互串
- 窄面 8 件 **133/133**；R2-08 用户路径守卫件 **7/7**（源码与两处产物 `C:/Users/` 字面量清零）
- 仓外负控：摘目录范围声明 ⇒ 范围声明格红；空清单改返空串（模拟省略）⇒ 显式「没有」格红；两道各自还原后复绿、真树 SHA 未动
