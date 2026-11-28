# ㊿-c-补⑫「风控触发面硬加固四件套」真机复验报告
<!-- 历史快照：内引路径/行号为当时状态（75e1fe0f / 38213bea / 745dfd2e 版），不作活锚 -->

## 0. 结论
**PASS（分层口径）**。四件套机制层全坐实：判据格独立窄面自跑全绿（ban-hardening-4piece 12＋response-classifier 39＋r4 10＝61/61）＋四件套源 diff 逐处核在位＋仓外负控三靶心命中（摘件①轮间⇒件①红、摘件②退避⇒件②红、摘件④-d 归一化⇒④-d 红）＋装版产物面锚全在。件③速率闸 cap 取 25（MAX_LOOP 口径，非卡面 12）——diff 注释已注明「若 PM 裁定 12 为准须改验收口径先报批」，本复验按 25 在位核，**口径偏差报 PM 裁定**（§8）。真机 confirm 弹窗格（原生对话框）由 dev 窗实测或出资人实测兜底，本窗未起 dev 窗、如实注记（§6）。

## 1. 冻结锚（复验前现算）
- HEAD `3cbbd83`（v0.14.37 抬号批）；修复批 `9c01d33`（26 文件）、抬号批 `3cbbd83`。
- `src/inject/main-world-interceptor.ts` 267,730 B／4,644 行／blob16 `75e1fe0f940ddf66`（全程未动）。
- `src/inject/response-classifier.ts` 27,796 B／573 行／blob16 `38213bea7da300bf`（全程未动）。
- `src/shared/continuation-prompt.ts` 56,398 B／1,103 行／blob16 `745dfd2ee1f10848`（全程未动；工具熔断轴 `TERMINAL_FAILURE_CODES` 不在此件本卡改动面内，四件套只加常量未碰既有逻辑）。
- `tests/desktop/ban-hardening-4piece.test.ts` 13,384 B／316 行／blob16 `f2a9744cc71c82c9`。
- 仓库 `src-tauri/inject/entry.js` 491,223 B／blob16 `3d7260c1d0c63655`（0.14.37 版）。
- 装版五值：exe 15,549,952 B／FileVersion 0.14.37／mtime 19:54:12；装版 entry.js 491,222 B（注：装版 491,223 与我仓库读数 491,223 一致，PM 报 491223）blob16 与仓库**逐字相等**（无混血）、mtime 19:50:14；main.mjs 842,012 B sha8 断形态 `26 33 C2 CE 6D E1 36 2E`（shared 改动后重建的新 host，区别于历版 `D1A05CEF`）。
- 实例（起核时现读）：装版 appPid 32160／宿主 node 24920／8760 True；dev 树 0；装版 sidecar 根基线 mtime 20:14:28。
- 本卡**未起 dev 窗**（真机 confirm 原生弹窗格按 §6 注记；机制层由单测＋负控定论，避免为冒烟多一轮构建漂移）。

## 2. 四件套源 diff 核实（逐处抽读）
- **件① 轮间间隔**（interceptor L3655-3662）：`setTimeout(..., 1500 + Math.round((Math.random()*2-1)*700))`，常量 `CONTINUATION_INTER_ROUND_MS=1500`／`JITTER_MS=700` 在 shared（L92-95）；只作用 auto-continue 轮，用户首发不经此。
- **件② 退避**（classifier L505-517）：`errorBackoffMs` 基线 `min(4000·2^n, 30000)`＋jitter 默认 1500（旧 2s/4s/8s 封顶 8000 抖动 300 已替）；序列 4s/8s/16s/30s。
- **件③ 速率闸**（interceptor L3901-3930＋常量）：`autoSendTimestamps` 滑动 5min 窗、`RATE_CAP_PER_WINDOW=25`；命中⇒`auto-send-rate-cap` 终局＋`finishStepFlow`＋清窗＋不烧重试；写入点＝auto-continue 路径（首轮重发 L3725 一带＋续跑 L3928），用户首发不计入。
- **件④ 同文护栏**（interceptor L2150-2188＋L2214-2218 fetch reject＋L2552-2559 XHR abort＋shared L108-122 常量）：`isDuplicateUserPrompt`（归一化键 120s 窗）⇒`window.confirm(DUPLICATE_PROMPT_CONFIRM_TEXT)`；取消⇒`xhr.abort()`/fetch `AbortError`（不发请求、不烧重试、不记录保留原时间戳）；确认/新问题⇒放行后**无条件 `recordUserPrompt`**（写点在 if 块外，首提也记录——PM 复核 2026-11-27 定的写点位置，本复验核其在位）。
- **负控靶心**（测试件头注释 L32-36 自注）：摘件①interRoundDelay⇒轮间 0；摘件③autoSendTimestamps⇒窗内 20 次全放行；摘件④归一化⇒同文不拦；摘件④confirm⇒不弹直接放行。

## 3. 判据格（独立窄面，真树自跑）
真树 3 件 vitest **61/61 EXIT=0**＋`npx tsc --noEmit` 整树 **EXIT=0**（全量闸归 PM，GATE#138/#139 已绿在案）：
- 件①：常量在位（1500±700∈[800,2200]）＋轮间等待行为采样非 0 非固定 1000；
- 件②：`errorBackoffMs(0..5,0)`＝4000/8000/16000/30000/30000 精确值＋默认抖动 200 采样落 [base, base+1500]；
- 件③：cap=25 在窗计数语义（≥cap 拦）＋超窗滚动放行＋**用户首发不计入**（interceptor 侧 `autoSendTimestamps` 仅 auto-continue 写，正常 1 请求不触 rate cap）；
- 件④：④-a 同文命中⇒confirm 弹、取消⇒abort 不发（body=null、diag `user cancelled`、chat 请求仅 1 枚）；④-b 确认⇒放行（body 非 null、2 枚）；④-c 新问题不弹 confirm；④-d 归一化（全角？/空白/大小写同键、窗口外不命中）。
- 同域回归：response-classifier 39 枚（含 ⑩⑪ challenge/auth 块全绿）＋r4-inject-guards 10 枚。

## 4. 仓外负控（`E:\NAS\negctl-v01437-ban12`，最小拷贝集＋node_modules junction，全绝对路径）
- 干跑（未变异）：3 件 **61/61 EXIT=0**（日志 `logs/negctl-ban12-dryrun.log`）；副本三源 blob16＝真树。
- **证A**（摘件①轮间 jitter、回固定 1000）：件①行为格红（轮间回 0/固定形态）；两道证：副本 interceptor blob16 变 vs 真树 `75e1fe0f`（未动）。
- **证B**（摘件②退避、回 2s/4s/8s 机器节拍）：件②序列格＋抖动格**双红**（2 failed）；两道证：副本 classifier blob16 `b1211302…` vs 真树 `38213bea`（未动）。
- **证C**（摘件④-d 归一化、`normalizePromptKeyForGuard` 换 identity）：④-d 归一化格**单红**（1 failed|11 passed）；两道证：副本 interceptor blob16 `84f5d0c6…` vs 真树 `75e1fe0f`（未动）。
- 真树 `git status --porcelain` 净。负控树留变异态（末次为证C）。

## 5. 装版产物面（正式 NSIS 安装＝合法真机路径）
装版 entry.js 491,223 B blob16 `3d7260c1…`＝仓库逐字相等（无混血）；main.mjs `2633C2CE`（shared 改动后重建的新 host）。转义形态锚现读（esbuild 中文=大写 `\uXXXX`、数值经 mangle 折叠，字符串字面量保留）：
- confirm 文案「该问题与上一条几乎相同」＝1 枚；`duplicate prompt guard` 诊断锚 3 枚、`user cancelled` 1、`user confirmed` 1（件④链全在）；
- `auto-send-rate-cap` 终局码 2 枚、`rate cap` 诊断锚 2 枚、「请求频率达到安全上限」文案 1 枚（件③链全在）；
- 旧机器节拍 `8000` 封顶字面量＝**0 枚**（件②已替，清零坐实）；`1500` 字面量 7 枚（含件①轮间基线）；
- 版本串 0.14.37＝1 枚。
- 注记：`30000`/`4000` 数值经 esbuild 常量折叠成表达式，不作字面量判据（同 ⑩ 函数符号 mangle 先例）。

## 6. 真机 confirm 格（分层注记）
件④的 `window.confirm` 是浏览器**原生对话框**，实际可用性（真机是否弹、取消/确认行为）需 dev 窗真发两枚同文 prompt（120s 内）实测；本窗未起 dev 窗，机制层由 ④-a/④-b 单测（FakeXHR 驱动真实 `captureChatRequest` 发送路径）＋负控定论。真机弹窗格**挂 dev 窗实测或出资人实测兜底**，如实注记、不冒充全层。

## 7. 验收席自认清单（本窗我犯的错，如实记录）
1. **负控三合一脚本件④-d 靶心未命中**：首版 `verify-ban12-mut.mjs` 把三枚变异串成一次写，件④-d 的 `from` 串因与源文件缩进不符（`UNEXPECTED_OCCURRENCES=0`）整体 exit 2 未写入，只落了件件①②；我随即还原副本、用正则精确切件④-d 单跑（`verify-ban12-mutC.mjs`）补净靶心。教训：多靶心变异脚本应逐枚独立写＋逐枚 occ=1 守卫，勿串成原子事务（一枚失配全废）。
2. 装版 entry.js 字节我现读 491,223、PM 卡面写 491,222（差 1，疑 PM 取数口径或末字节 CRLF）——我以**仓库现算 491,223＋装版 blob16 与仓库逐字相等**为准，未据此判混血（blob16 相等即逐字同，字节差属读数口径），记档待你复核。
3. 全程未碰装版 32160/24920/8760 与装版资源目录；真树 git 净。

## 8. 口径偏差（报 PM 裁定，不代裁）
件③速率闸 cap 取 **25**（＝MAX_LOOP，保证 25 轮工具续跑不碰闸），非卡面 12。diff 注释（continuation-prompt.ts L311-317）已写明：卡面 12 是「正常轮次」口径、25 是「含重试异常轮次」口径，若 PM 裁定 12 为准须把 MAX_LOOP 回归驱动改成 <12 轮（改验收口径、先报批）。本复验按 25 在位核、不替 PM 拍板。

## 9. 收工四项（零实例口径）
本卡未起 dev 窗、未动装版：① `deepseek-studio.exe` 进程数＝**1**（装版 32160，原样保留）；② 命令行含 `host\main.mjs` 宿主 node＝**1**（装版 24920），dev-main.ts＝0；③ 8760＝**True（装版持有）**／8761＝False／9222＝False（可连性形态现读）；④ 装版 sidecar 根 `%APPDATA%\com.deepseek.studio\logs` 根 mtime 20:14:28（卡面基线，本窗未起窗未推进）；dev 根自 ⑨ 收工后无新文件（本窗未起 dev 窗）。

## 10. 取证件索引
- 独立窄面：真树 3 件 61/61（ban-hardening-4piece 12＋response-classifier 39＋r4 10）＋tsc EXIT=0。
- 负控：`E:\NAS\negctl-v01437-ban12`（留证C变异态）、干跑日志 `logs/negctl-ban12-dryrun.log`、变异脚本 `logs/verify-ban12-mut.mjs`（件①②）＋`logs/verify-ban12-mutC.mjs`（件④-d，正则切）。
- 装版产物面：`logs/verify-ban12-installed-probe.mjs`（confirm 1/dup-guard 3/cancelled 1/confirmed 1/rate-cap 2/rate cap 2/安全上限文案 1/8000=0/1500=7/0.14.37=1）。
- 源 diff 留痕：`logs/verify-ban12-src.diff.txt`（327 行，interceptor/classifier/continuation 三件全 diff）。
