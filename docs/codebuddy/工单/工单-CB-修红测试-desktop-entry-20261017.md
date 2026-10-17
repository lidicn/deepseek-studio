# 工单 · CB · 修红测试 desktop-entry（2026-10-17）

> 类型：**工单**（封闭任务，无需目标模式）
> 发起：主开发（豆包工作）
> 承接：CodeBuddy（副开发）
> 优先级：P0（阻塞「全绿」验收口径）

---

## 1. 任务

修复 `tests/desktop/desktop-entry.test.ts` 的唯一失败用例，使 `npm run test` 达到 **765 / 765 全绿**。

## 2. 现状（已实测，勿重复调查）

```
FAIL  tests/desktop/desktop-entry.test.ts > 注入装配（entry + shims）
      > installStudio 装配直连桥并挂 window.__deepseekStudio

TypeError: document.addEventListener is not a function
 ❯ Module.installStudio src/desktop/entry.ts:189:16
    187|     };
    188|     if (document.readyState === \'loading\') {
    189|       document.addEventListener(\'DOMContentLoaded\', mountStudioUI, { once: true });
       |                ^
 ❯ tests/desktop/desktop-entry.test.ts:36:23
```

基线：`1 failed | 71 passed (72)` 文件，`1 failed | 764 passed (765)` 用例。

## 3. 根因判定（已核实）

jsdom 环境里 `document.addEventListener` 未被提供（测试的 shim 不完整）。

**这是预存在的基线失败，不是任何近期改动引入的回归。** 依据：
- `docs/交接班/交接班_20261016.md` §2.1「关键坑」明确记录：
  > `desktop-entry.test.ts` 的 `document.addEventListener is not a function` 是**预先存在**的 jsdom shim 失败（基线同红），非本次引入。
- `src/desktop/entry.ts:189` 的逻辑本身正确（`readyState === 'loading'` 时才挂事件，否则直接调用 `mountStudioUI()`）。**不要去改生产代码来迁就测试。**

## 4. 允许改动的文件（严格边界）

| 允许 | 禁止 |
|---|---|
| `tests/desktop/desktop-entry.test.ts` | ❌ `src/desktop/entry.ts`（生产代码） |
| 新增/修改 `tests/` 下的 setup shim 文件 | ❌ 任何 `src/**` |
| `vitest.config.ts`（仅当需要加 setupFiles） | ❌ `src/inject/main-world-interceptor.ts` |

**若你判断必须改生产代码，停下来，写进完工卡说明，不要动。**

## 5. 两条可选路径（自选其一，说明理由）

**路径 1 · 在测试内补 shim（推荐，最小侵入）**
在 `desktop-entry.test.ts` 的 setup 段（用例之前）补齐 jsdom 缺失的 DOM 能力，例如让 `document` 具备 `addEventListener` / `readyState`。要点：shim 必须是**幂等**的，且不得影响其他测试文件的 jsdom 环境。

**路径 2 · vitest setupFiles**
新增 `tests/setup/jsdom-shims.ts`，在 `vitest.config.ts` 注册 `setupFiles`。要点：全局生效，**必须重新跑全量确认没有把别的测试从红改绿或从绿改红**。

## 6. 验收（必须逐条贴原始输出）

```
1) npm run test -- tests/desktop/desktop-entry.test.ts
   期望：2 passed (2)

2) npm run test
   期望：Test Files  72 passed (72)
         Tests      765 passed (765)

3) npm run typecheck
   期望：0 错（EXIT=0）
```

> 跑全量提示：`npx vitest run` 会超过 120s，建议后台重定向到文件再轮询。且 vitest 输出含 ANSI 转义，grep 前先剥：
> `(Get-Content 文件 -Raw) -replace \'\x1b\[[0-9;]*[a-zA-Z]\',\'\'`

## 7. 交付物

`docs/codebuddy/工单/完工-CB-修红测试-desktop-entry-20261017.md`，含：
- 选了哪条路径 + 为什么
- §6 三条命令的**原始输出粘贴**
- 是否触碰了 §4 的禁止区（应为「否」）
- 遗留风险（若有）

## 8. 边界声明

- 本工单**不涉及**内核归位（A 线）与 Bot 平台（B 线）任何改动。
- 本工单与 `main-world-interceptor.ts` 无关，不触发写权冲突。
- 完成后**不要**顺手做其他清理——保持提交单一目的。