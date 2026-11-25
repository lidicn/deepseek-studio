# ㊿-c-补⑩「40303 CHALLENGE_REQUIRED 误判成服务器故障」真机复验报告
<!-- 历史快照：内引路径/行号为当时状态（1f4c9c99 / c11c77dd 版），不作活锚 -->

## 0. 结论
**PASS（分层口径，同 ⑥ 熔断 notice 先例）**。机制层全坐实：判据四格独立窄面自跑全绿＋MI 四处消费点逐处核在位＋TERMINAL_FAILURE_CODES（工具熔断轴）未动＋仓外负控靶心命中（摘挑战判定调用点⇒①④红）＋装版产物面转义锚全在。真机 40303 由上游控制、不可按需逼出（本会话窗口未发生挑战响应），**真机文案格由出资人下轮实测兜底**，如实注记、不冒充全层。

## 1. 冻结锚（复验前现算）
- HEAD `5e04b85`（v0.14.35 抬号批）；修复提交 `be9028d`（5 文件：entry.js 重建、interceptor +34、response-classifier +106、新测试件 2 枚）。
- `src/inject/response-classifier.ts` 24,788 B／525 行／blob16 `c11c77dd25d07215`（全程未动）。
- `src/inject/main-world-interceptor.ts` 254,786 B／4,442 行／blob16 `1f4c9c99cae0c63b`（＝四处消费点在位的载体）。
- `tests/desktop/response-classifier.test.ts` 15,044 B／329 行／blob16 `cd857bf2…`；`tests/desktop/challenge-required-closeout.test.ts` 6,666 B／167 行／blob16 `b5558925…`。
- 仓库 `src-tauri/inject/entry.js` 487,062 B／blob16 `61fde70f3e2b7d33`。
- 装版五值：exe 15,549,952 B／FileVersion 0.14.35／mtime 01:25:56；装版 entry.js 487,062 B blob16 与仓库**逐字相等**（无混血）、mtime 01:20:36；main.mjs 841,923 B sha8 断形态 `D1 A0 5C EF 8B 55 D0 0B`。
- 实例（起核时现读）：装版 appPid 5968／宿主 node 424（命令行含 `host\main.mjs`）／8760 True；dev 树 0。
- 本卡**未起 dev 窗**（卡面分层口径：机制层定论、真机格出资人兜底；正常会话不误伤由 closeout 测试件「正常 SSE 对照格」＋全量闸覆盖，避免为冒烟多一轮构建漂移，如实注记）。

## 2. 修复链核实（diff 原文抽读）
- `response-classifier.ts`：`ResponseVerdict` 联合加 `challenge-required`；`ChallengeInfo` 接口（provider/challengeId/expectedMode）；`detectChallengeRequired` 纯函数（命中三条件任一：外层 code===40303／msg==='CHALLENGE_REQUIRED'／任一层 challenge_id；读取层 data→data.biz_data→顶层逐层下探，与 `detectQuotaWall` 同款）；`parseChallengeFromText` 仅纯 JSON 体（SSE/非 JSON 返 null 不误伤）；`composeChallengeMessage` 文案唯一真源（expectedMode 缺省省略括号段）；`classifyResponse` 200 分支判定序＝**额度墙→挑战→parseBodyError**（额度墙优先级不被抢，卡面裁定在位）；`extractErrorText` 未顺手认 `msg`（卡面裁定在位，diff 无该改动）。
- `main-world-interceptor.ts` 四处消费点（现盘行号，卡面扩格逐处对应）：**L2818** 首轮 XHR 收口支、**L3132** settleStreamEnd 支、**L3917** auto-continue 首轮重发支、**L3949** budgetExhausted 条件＋**L3962** 收口支——逐处 `d(...)`＋trace `turn.end stopReason:'challenge-required'`＋`finishAssistantMessage({recordFinal:false})`＋`appendError('challenge-required', composeChallengeMessage(...))`＋`setBusy(false)`，不 escalate、不烧重试。
- `TERMINAL_FAILURE_CODES`（`src/shared/continuation-prompt.ts` L174，工具熔断轴）**修复提交 5 文件不含此件、内容未动**，challenge-required 为流收口终局、不进工具熔断轴（卡面裁定在位）。

## 3. 判据四格（独立窄面，真树自跑，不认他人绿）
真树 3 件 vitest **45/45 EXIT=0**＋`npx tsc --noEmit` 整树 **EXIT=0**（全量闸归 PM，GATE#132/#133 已绿在案）：
- 格①（`response-classifier.test.ts` 新增块）：`classifyResponse(200, 40303挑战体)`⇒verdict=challenge-required、reason=challenge-required，data 层 provider=shumei／challengeId／expectedMode=spatial_select 三字段逐字读出 ✓；
- 格②：额度墙体⇒仍 quota-exhausted（挑战判定不抢优先级）✓；
- 格③：code:0 成功包⇒ok、401/402/403⇒fatal、429/500⇒retryable 全回归不变✓（`r4-inject-guards` 10 件同域回归同绿）；
- 格④（`challenge-required-closeout.test.ts`）：200＋40303 体⇒**只发 1 枚请求**（对照旧路径烧 2 枚）、appendError `challenge-required` 文案含「人机验证」＋`spatial_select`、**不含「服务器暂时无法访问」**（全部 appendError 文案扫描）、setBusy(false)✓；另有「正常 SSE 成功流不挂 challenge-required」对照格✓；
- 附加格：`detectChallengeRequired` 命中三条件任一＋无命中⇒null（含 code:40303 无 data⇒空对象）；`composeChallengeMessage` expectedMode 在/缺两形态＋undefined 兜底。

## 4. 仓外负控（`E:\NAS\negctl-v01435-challenge10`，最小拷贝集＝整 src＋tests＋vitest.config.ts＋package.json＋tsconfig.json＋node_modules junction，全绝对路径）
- 干跑（未变异）：3 件 **45/45 EXIT=0**（日志 `logs/negctl-challenge10-dryrun.log`）；副本 classifier blob16＝真树 `c11c77dd…`。
- **变异**（摘 `classifyResponse` 200 分支的挑战判定调用点：`parseChallengeFromText(bodyText)` 唯一调用点改 `null`，单行、按真实控制流可达）⇒ **格①红**（40303 落回 parseBodyError 可重试路径）＋**格④红**（流收口不再挂 challenge-required 终端）；②③及 r4 回归 43 枚全绿（2 failed | 43 passed，EXIT=1）。
- 两道证：副本 classifier blob16 变后 `34b95765…` vs 真树 `c11c77dd…`（未动）、退出码与输出同读；真树 `git status --porcelain` 净。负控树留变异态。

## 5. 装版产物面（正式 NSIS 安装＝合法真机路径）
装版 entry.js 487,062 B blob16 `61fde70f…`＝仓库逐字相等（无混血）。转义形态锚现读（esbuild 中文=大写 `\uXXXX`，先读真件形态再写匹配式）：
- 挑战文案「需要完成人机验证才能继续」＝**1 枚**（与 PM 预核一致）；「手动完成一次验证」行动路径段 1 枚；
- `challenge-required` 字符串字面量＝**17 枚**（verdict/reason/stopReason/appendError code 全链，与 PM 预核一致）；
- `detectChallengeRequired`／`composeChallengeMessage` 函数符号 0 枚＝esbuild mangle 改名预期（字符串字面量保留，函数名不作判据，如实注记）；
- 旧 escalate 文案「服务器暂时无法访问」＝8 枚在位＝**generic retryable 路径设计保留**（卡面只裁挑战路径不再用它，非全文清零，口径与卡面一致）。

## 6. 真机 40303 格（分层注记，不冒充全层）
上游挑战响应不可按需触发：本复验窗内（dev 未起、装版 5968 未碰）未发生 40303 现场，机制层由 §3 单测＋§4 负控＋§5 产物面定论；「装版真机撞挑战时文案变成『需要完成人机验证』且不再报服务器故障」由**出资人下轮实测兜底**（同 ⑥ 熔断 notice 先例，挂账维持）。

## 7. 验收席自认清单（本窗我犯的错，如实记录）
1. 首查 TERMINAL_FAILURE_CODES 在 `src/inject` 下 grep 只中 1 枚注释（L3214），差点误判「定义不在注入层」——扩到 `src/shared` 才找到真定义（continuation-prompt.ts L174）：0 枚/1 枚先查匹配面再下结论（AGENTS 五族同型）。
2. 装版探针首跑含 `chat.deepseek.com` 计数 9 枚未先读真件分布（含拦截器 URL 判断等其他用途），只可作上下文、不可当判据——该枚已从结论中剔除（仅记录）。
3. 全程未碰装版 5968/424/8760 与装版资源目录；真树 git 净。

## 8. 收工四项
本卡零实例（未起 dev 窗、未动装版），按卡面口径报**装版侧四项现读**：① `deepseek-studio.exe` 进程数＝**1**（装版 5968，原样保留）；② 命令行含 `host\main.mjs` 宿主 node＝**1**（装版 424），dev-main.ts＝0；③ 8760＝**True（装版持有）**／8761＝False／9222＝False（可连性形态现读）；④ 装版 sidecar 根 `%APPDATA%\com.deepseek.studio\logs` 根 mtime 01:36:01／最新 `sidecar-1795628161077.log` 01:36:04（本窗未起窗，未推进；卡面现场取证引用的 `sidecar-1795583434364.log` 为 0.14.34 时期旧文件）；dev 根 `%APPDATA%\deepseek-studio\logs` 自 ⑨ 收工后无新文件（本窗未起 dev 窗，现读最新仍 05:55:19）。

## 9. 取证件索引
- 独立窄面：真树 3 件 45/45（response-classifier 33＋r4-inject-guards 10＋challenge-required-closeout 2）＋tsc EXIT=0。
- 负控：`E:\NAS\negctl-v01435-challenge10`（留变异态）、干跑日志 `logs/negctl-challenge10-dryrun.log`、变异脚本 `logs/verify-challenge10-mut.mjs`（单行调用点摘除＋occurrence=1 守卫）。
- 装版产物面：`logs/verify-challenge10-installed-probe.mjs`（锚 1/17/0/0/8/1/9）。
