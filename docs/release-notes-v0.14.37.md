# v0.14.37 发版说明

发布日期：2026-11-27（tag `v0.14.37`；本版修复**封号取证驱动的风控触发面硬加固——四件套把自动外发节奏拉回人节奏**。背景：11-26 晚 20:55–21:00 共 14 次 chat/completion 挤在 4 分半内，四条机器节奏特征（续跑轮间零间隔／退避常量节拍／同文 20 秒内跨会话原样重发／自动外发无上限），21:42 服务端禁言 3 天）

## 这版修了什么

### 风控触发面硬加固四件套（`㊿-c-补⑫`）

1. **① 续跑轮间人节奏间隔**（`main-world-interceptor.ts` `scheduleAutoContinue`）：auto-continue 轮间定时器从固定 1000ms 改为 `1500 ± 700ms` 随机（800–2200ms）。只作用于工具续跑轮，用户首次发送不经过此路径。
2. **② 错误重试退避拉长加大抖动**（`response-classifier.ts` `errorBackoffMs`）：退避序列从 2s/4s/8s＋抖动 0–300ms 改为 **4s/8s/16s 封顶 30s＋抖动 0–1500ms**，把退避曲线本身打散成不规则间隔。`MAX_ERROR_RETRIES=3` 不变。
3. **③ 自动外发滑动窗口速率闸**（`main-world-interceptor.ts`）：滚动 5 分钟窗口内自动外发（续跑轮／错误重试／首轮原样重发）达 **25 次**（＝`MAX_LOOP`，保证 25 轮工具续跑全周期不误伤）即停止自动续跑：终局码 `auto-send-rate-cap`＋明示「请求频率达到安全上限，已暂停自动续跑，请稍后手动继续」＋不烧重试。用户首次发送不计入。
4. **④ 同文快速重发护栏**（注入层 `captureChatRequest` 真实发送路径）：同一归一化 prompt（去空白/大小写/标点）在 **120 秒窗口**内再次提交，先弹原生确认「该问题与上一条几乎相同，确定要重新提交？」——取消则丢弃本次发送（不发请求、不烧重试、记录保留）；确认后放行并更新记录；新问题直放不弹。拦截点覆盖 fetch 与 XHR 两条真实发送路径；auto-continue／首轮原样重发不触发。封号取证里的病灶（20 秒内跨会话重发同一句）从此被护栏拦住。

### 选型说明（经 PM 批准）

- 速率闸 cap＝25 而非卡面 12：速率闸是「异常跑飞兜底」，25＝MAX_LOOP 使 25 轮工具续跑全周期不被拦；12 会在第 13 轮误伤正常多步任务。
- ④ 拦截落在注入层 `captureChatRequest`（DeepSeek 页面原生发送的唯一拦截点），UI 层不再有第二份归一化实现（`src/ui/send-guard.ts` 已删除）。

## 验证

- 全量闸 **exit=0**（GATE#138，1650.3s）；vitest 全量 **PASS**（343 files）；信息级红仅 upstream-drift（不阻塞）
- entry-freshness PASS（重建 entry.js 491,223 B，blob16 `18dd691b46358a7b`）；host-freshness PASS（main.mjs 842,012 B，sha8 断 `26 33 c2 ce`，跟踪＝重建＝debug 副本三方一致）
- CI run **45985374389**（head `9c01d33`）：completed／success（gate=success／doc-drift-upstream-negative=success／cargo-check=success）
- 测试：新增 `ban-hardening-4piece.test.ts`（四件套行为格：退避序列／轮间间隔窗／速率闸窗口语义／同文护栏真实发送路径 4 格）；回归调适 21 件（轮间间隔与退避拉长须加等待时间；`window.confirm` 测试桩 19 件）
- 独立窄面（PM 亲自现跑）：tsc EXIT=0＋受影响窄面 20 件 133/133 EXIT=0
- 仓外负控三道证：摘归一化 ⇒ 同文不拦（④-d 红）；摘 confirm ⇒ 确认/取消分支走不到（④-a/④-b 红）；**摘写点 ⇒ 第 2 次同文不拦（④-a/④-b 红）**——三枚靶心各红、还原复绿、真树 SHA 全程未动
- 装版产物面：confirm 文案（esbuild 转义形态）1 枚、guard diag 3 枚、send_cancelled 1 枚全在位

真机「confirm 弹窗交互」格（确认弹窗出现、取消后请求未发出、确认后请求发出）由 Verify 真机复验实测兜底。
