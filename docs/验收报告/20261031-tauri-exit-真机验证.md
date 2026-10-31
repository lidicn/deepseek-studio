# Tauri 退出链路真机验证（20261031）

- 项目：`E:\NAS\deepseek-studio`
- 席位：Core（内核/宿主）
- 时间：2026-10-31 14:50 – 15:55
- 任务卡：Tauri 退出链路真机验证（第 3 批 WIP），阶段 A 读 diff + `cargo check`，阶段 B 真机
- 改动范围：`src-tauri/src/main.rs`（+78/−1）、`src-tauri/src/sidecar.rs`（+41/−11），**未提交**
- 结论：**部分通过**。单窗退出链路达标；**多窗（≥1 个 bot/工作台窗）关闭仍挂死不退出、剩余窗全程可见并抢焦点——用户抱怨的“关闭时乱闪/退不掉”未修好**。

---

## 1. 结论摘要

| 验证项 | WIP 结果 | 对比 pre-WIP 基线（HEAD 重建） |
|--------|----------|------------------------------|
| 单窗关闭 → 进程退出 | ✅ 2.53s / 2.81s，退出码 0（2/2 达标；首跑抖动 4.87s） | 未测单窗基线 |
| 多窗关闭 → 进程退出 | ❌ **30s 预算内不退出，被迫强杀**（主窗+工作台、主窗+bot 各 1 轮） | ❌ 同样不退出（30.8s 强杀） |
| 主窗关闭后立刻不可见 | ✅ 单窗 212ms / 411ms（首跑 2451ms 抖动）；多窗时主窗 361ms 不可见 | ❌ 全程可见 |
| 其余窗口不闪 / 不抢焦点 | ❌ **其余窗 30s 全程可见，前台在它和黑框间来回跳 244/252 次采样** | ❌ 更差（254 次采样） |
| 只退出一次（CloseRequested / sidecar stopped 各 1 次） | ✅ 4 轮均 1 次 | ✅ 1 次 |
| sidecar 退出 & 8760 释放 | ✅ 全部轮次 | ✅ |
| 关闭后立刻再点图标不闪回 | ✅ 第二实例 654–681ms 退出，落 `second instance ignored (shutting down)`，期间可见窗未增加 | ❌ 无该日志（旧逻辑会 show/focus） |
| `port_in_use()` 短路生效 | ✅ 关闭期子进程无 `powershell.exe`（4/4 轮） | ❌ `powershell.exe`×2 |
| taskkill 500ms 节流 | ✅ 2–3 次 | ❌ 7–8 次 |
| debug 控制台窗隐藏 | ✅ `ConsoleWindowClass` 存在但 `IsWindowVisible=false`（4/4 轮） | ❌ 控制台窗可见 |
| 3 个可见窗（主 + 2 个 bot/工作台） | ⚠️ 无法构造：**既有缺陷**，一进程只能多建 1 个窗 | ⚠️ 同样无法构造 |

---

## 2. ⚠️ 前提修正：任务卡说的“旧 exe 不含 WIP”不成立

任务卡与 PM 现场判断均基于「当前 exe 是 10-30 22:46 构建、不含 WIP」。实测**否**：

```
findstr /C:"second instance ignored" src-tauri\target\debug\deepseek-studio.exe
→ FOUND        # 该字符串只存在于 WIP 的 main.rs（v0.32 单实例短路）
```

- 该 exe：20,008,960 B，mtime 2026-10-30 22:46:45，SHA256 `CD2EF48F2BD03E33B9C21F7EB17C9D410553E9818F4689790A996187664DCD9D`
- 源码 mtime（`main.rs` 21:05、`sidecar.rs` 21:08）**早于**构建时间（22:43/22:46）→ cargo 认为 fresh；
  但二进制里已有 WIP 字符串 → 说明 WIP 内容在 21:05 前就已落盘，22:46 的构建已含它。
- 因此 **PM 现场观察到的“关闭 7.5s 不退、sidecar 滞留 10s+”不是旧行为，而是含 WIP 的构建行为**。

处置（未改工作区、未做 git checkout/reset）：

```powershell
git archive --format=zip -o logs\verify-exit\baseline-build\src.zip HEAD src-tauri   # 只读导出
Expand-Archive ...
$env:CARGO_TARGET_DIR='...\baseline-build\target'; cargo build --offline
```

- 真基线产物：19,992,576 B，SHA256 `65E7A6285783A733A8A6D293E5A64F0D70213DDEB055EBE9F7A5FDAF301FAFA0`
- 其二进制中 `second instance ignored` = **absent**（确认是真 pre-WIP）
- 复制到 `src-tauri\target\debug\deepseek-studio-baseline-preWIP.exe`（同深度目录，保证 `project_root` 推导正确）

### 被测 WIP 二进制

| 项 | 值 |
|----|----|
| 路径 | `src-tauri\target\debug\deepseek-studio.exe` |
| 构建 | `cargo clean -p deepseek-studio && cargo build`（2m07s，EXIT=0）——因源码 mtime 倒挂，普通 `cargo build` 会误判 fresh 不重建 |
| SHA256 | `72E3094FF42D8D881FA957C296D6F5FBACFCE12C626E970FE9433ABA77EB63F7` |
| 大小 / mtime | 20,008,960 B / 2026-10-31 14:54:33 |
| 含 WIP 证据 | `second instance ignored` = FOUND |
| 链接验证 | 另用独立 target 目录全量 `cargo build`（7m53s，EXIT=0，0 warning）确认 `kernel32/user32` extern 可链接 |

---

## 3. 方法

### 3.1 工具（`logs/verify-exit/`，`logs/` 已 gitignore）

| 文件 | 作用 |
|------|------|
| `verify-exit.ps1` | 单轮编排 + 自动断言 + 落 `roundNN.summary.json` |
| `WinProbe.ps1` | 只读 Win32：EnumWindows / IsWindowVisible / GetWindowText / GetForegroundWindow / ConsoleWindowClass |
| `sampler.ps1` | 窗口采样（实测 ~120–140ms/拍）：可见窗数、标题、前台窗口 |
| `child-sampler.ps1` | 子进程采样（400ms/拍）：抓 `taskkill/netstat/tasklist/powershell` |
| `make-windows.mjs` | CDP(9222) 调 Tauri 命令建窗：`open_workbench` / `open_bot_window` |
| `probe-bot*.ps1` / `probe-order*.ps1` / `probe-two.ps1` | 建窗能力探针（见 §5） |

### 3.2 每轮步骤

1. 预检：无 `deepseek-studio*.exe`、8760 空闲、CDP 9222 空闲（否则拒绝开跑）。
2. 带日志重定向启动：
   ```powershell
   Start-Process -FilePath $exe -WorkingDirectory 'E:\NAS\deepseek-studio' -PassThru `
     -RedirectStandardOutput ...\roundNN.out.log -RedirectStandardError ...\roundNN.err.log
   ```
3. 等 `/healthz` 200 + 主窗可见（`Tauri Window` / `DeepSeek++ Studio`）。
4. 经 CDP 建 1 个额外窗（工作台或 bot，独立 profile 落 `logs\verify-exit\profile-botN`）。
5. 起两个采样器。
6. `PostMessage(mainHwnd, WM_CLOSE)`（等价点 X），记 `tClose`。
7. `tClose+150ms` 起第二个同 exe 实例（测“关闭后立刻双击”）。
8. 等宿主退出（预算 30s，超时强杀并标注）。
9. 停采样器 → 断言 → 落 summary。

### 3.3 为什么 R2/R3 各 1 个额外窗（而不是 3 窗）

实测**一个进程生命周期内只能多建 1 个窗口**：第 2 个 `open_workbench`/`open_bot_window` 的命令处理器会挂住，invoke promise 永不 settle，窗口不出现（`profile-*` 目录为空；`window.__probe` 停在 `pending`）。

- 换顺序（bot 先、工作台后）同样只有第 1 个成功；
- 同一 tick 连发两条命令，也只有工作台出现；
- **pre-WIP 基线同样复现** → 属既有缺陷，与本次 WIP 无关。
- 探针证据：`probe-bot.console.log`（bot 单独建 → 307ms 成功）、`probe-bot2.console.log`、`probe-order.console.log`、`probe-two.console.log`。

因此 R2 用 main+工作台、R3 用 main+bot，两类窗口都覆盖，而不是强凑 3 窗。

---

## 4. 每轮原始输出

原始文件：`logs/verify-exit/roundNN.{out,err}.log`、`roundNN.samples.jsonl`、`roundNN.children.json`、`roundNN.windows.log`、`roundNN.console.log`、`roundNN.summary.json`。

### R0 — pre-WIP 基线（HEAD 重建，main + 工作台）

```
[pre] 预检通过：无实例、8760 空闲、9222 空闲
[run] 启动 pid=22788，/healthz 就绪 9409ms，主窗可见 9567ms
[FAIL] 多窗口就绪（3 个可见窗） 共 2 个：DeepSeek++ Studio · 工作台 visible=True | DeepSeek++ Studio visible=True
[PASS] WM_CLOSE 已投递到主窗口 hwnd=461320
[run] 第二实例：{"attempted":true,"appAliveAtLaunch":true,"startedMs":165,"launchedPid":20588,"exitMs":443,"exitCode":0}
[FAIL] 宿主进程在预算内退出 tClose→exit=30817ms      ← 30s 预算耗尽，强杀
[FAIL] 退出码 = 0 exitCode=
[PASS] 8760 已释放 / 无残留 Studio / 无残留 node 宿主 / 无残留 WebView2
[PASS] CloseRequested(main) 恰好 1 次 / window state 保存 1 次 / sidecar stopped 恰好 1 次
[PASS] 事件顺序 CloseRequested→state saved→sidecar stopped idx=402/475/503
[FAIL] 退出窗口期第二实例被忽略（不闪回） count=0        ← 旧逻辑无该短路
[FAIL] 关闭 300ms 后无可见 Studio 窗口 maxVisible=2 firstAllHidden=(无) graceRows=256
[FAIL] 前台从未落到 bot/工作台窗 hits=208
[FAIL] 关闭 300ms 后前台不再停留在 Studio 窗口 hits=254
[FAIL] 第二实例未把窗口闪回来 可见窗>0 的采样行=257
[FAIL] 退出未走 PowerShell CIM 昂贵兜底 关闭后子进程: NETSTAT.EXE,powershell.exe,taskkill.exe; powershell=2
[PASS] 退出确实执行了进程树清理 taskkill 次数=7
[FAIL] debug 控制台窗口已隐藏 console windows=1 visible=1
==== round00 结果：FAIL (10) ====
```

要点：**两个窗口在 30.8s 内一直可见**（`maxVisible=2`，从未出现 0 可见窗）；前台在 Studio 窗口之间跳 208 次；`powershell.exe` 2 次、`taskkill` 7 次；控制台窗可见。

### R1 — WIP 冒烟（单窗，重定向）

```
[run] /healthz 就绪 7672ms，主窗可见 7795ms
[PASS] 多窗口就绪（1 个可见窗）
[run] 第二实例：未启用
[PASS] 宿主进程在预算内退出 tClose→exit=4874ms
[PASS] 退出码 = 0
[PASS] 8760 已释放 / 无残留 Studio / node / WebView2
[PASS] CloseRequested(main)=1 / state saved=1 / sidecar stopped=1 / 事件顺序正确
[PASS] 窗口状态文件已更新
[FAIL] 关闭 300ms 后无可见 Studio 窗口 maxVisible=1 firstAllHidden=2451ms graceRows=36
[FAIL] 关闭 300ms 后前台不再停留在 Studio 窗口 hits=16
[PASS] 退出未走 PowerShell CIM 昂贵兜底 关闭后子进程: taskkill.exe,tasklist.exe; powershell=0
[PASS] taskkill 次数=3
[PASS] 控制台窗已隐藏（console windows=1 visible=0）
==== round01 结果：FAIL (2) ====
```

采样时间线（关键）：`tClose+84ms` 主窗仍可见 → `tClose+2451ms` 变 0 → 4.87s 进程退出。即**主窗直到销毁那一刻才消失**，不是“立刻隐藏”。此轮是构建后首跑，后两轮（R4/R5）同配置均为 200–411ms，判为冷启动/首跑抖动。

### R2 — WIP 完整（main + 工作台 + 第二实例）

```
[run] /healthz 就绪 7071ms，主窗可见 7358ms
[PASS] 工作台窗创建命令成功 exit=0
[PASS] 多窗口就绪（2 个可见窗）：DeepSeek++ Studio · 工作台 visible=True | DeepSeek++ Studio visible=True
[run] 第二实例：{"appAliveAtLaunch":true,"startedMs":161,"exitMs":681,"exitCode":0}
[FAIL] 宿主进程在预算内退出 tClose→exit=30990ms     ← 30s 预算耗尽，强杀
[FAIL] 退出码 = 0 exitCode=
[PASS] 8760 已释放 / 无残留 Studio / node / WebView2
[PASS] CloseRequested(main)=1 / state saved=1 / sidecar stopped=1 / 事件顺序正确
[PASS] 退出窗口期第二实例被忽略（不闪回） count=1
[FAIL] 关闭 300ms 后无可见 Studio 窗口 maxVisible=1 firstAllHidden=(无) graceRows=247
[FAIL] 前台从未落到 bot/工作台窗 hits=244
[FAIL] 关闭 300ms 后前台不再停留在 Studio 窗口 hits=244
[FAIL] 第二实例未把窗口闪回来 可见窗>0 的采样行=247
[PASS] 退出未走 PowerShell CIM 昂贵兜底 关闭后子进程: NETSTAT.EXE,taskkill.exe; powershell=0
[PASS] taskkill 次数=3
[PASS] 控制台窗已隐藏
==== round02 结果：FAIL (6) ====
```

采样时间线：

```
  67ms vis=2 titles=[工作台, 主窗] fg=[工作台]
 207ms vis=2 titles=[工作台, 主窗] fg=[工作台]
 361ms vis=1 titles=[工作台]        fg=[工作台]      ← 主窗消失
 532ms vis=1 titles=[工作台]        fg=[…\deepseek-studio.exe]   ← 焦点掉到控制台黑框
1002ms vis=1 titles=[工作台]        fg=[工作台]      ← 又跳回来
 …（此后 30s 持续：工作台窗可见，前台在工作台/黑框之间来回）
30990ms 超时强杀
```

### R3 — WIP 完整（main + bot 独立 profile + 第二实例）

```
[PASS] bot 窗创建命令成功 exit=0
[PASS] 多窗口就绪（2 个可见窗）：DeepSeek++ Studio [verify3] visible=True | DeepSeek++ Studio visible=True
[run] 第二实例：{"appAliveAtLaunch":true,"startedMs":161,"exitMs":654,"exitCode":0}
[FAIL] 宿主进程在预算内退出 tClose→exit=31016ms
[FAIL] 退出码 = 0
[PASS] 8760 已释放 / 无残留 Studio / node / WebView2
[PASS] CloseRequested(main)=1 / state saved=1 / sidecar stopped=1 / 事件顺序正确
[PASS] 退出窗口期第二实例被忽略（不闪回） count=1
[FAIL] 关闭 300ms 后无可见 Studio 窗口 maxVisible=1 firstAllHidden=(无) graceRows=255
[FAIL] 前台从未落到 bot 窗 hits=252
[FAIL] 关闭 300ms 后前台不再停留在 Studio 窗口 hits=252
[PASS] 退出未走 PowerShell CIM 昂贵兜底 关闭后子进程: taskkill.exe,tasklist.exe; powershell=0
[PASS] taskkill 次数=3
[PASS] 控制台窗已隐藏
==== round03 结果：FAIL (6) ====
```

### R4 — WIP bare 启动（不重定向，模拟双击；单窗）

```
[PASS] 多窗口就绪（1 个可见窗）
[PASS] 宿主进程在预算内退出 tClose→exit=2529ms
[PASS] 退出码 = 0
[PASS] 8760 已释放 / 无残留 Studio / node / WebView2
[PASS] 关闭 300ms 后无可见 Studio 窗口 maxVisible=0 firstAllHidden=212ms
[PASS] 前台从未落到 bot/工作台窗 hits=0
[PASS] 退出未走 PowerShell CIM 昂贵兜底 关闭后子进程: taskkill.exe,tasklist.exe; powershell=0
[PASS] taskkill 次数=3
[PASS] debug 控制台窗口已隐藏（console windows=1 visible=0）
==== round04 结果：PASS ====
```

### R5 — WIP 单窗复跑（重定向，验 R1 抖动）

```
[PASS] 宿主进程在预算内退出 tClose→exit=2809ms
[PASS] 退出码 = 0
[PASS] CloseRequested(main)=1 / state saved=1 / sidecar stopped=1 / 事件顺序正确
[PASS] 关闭 300ms 后无可见 Studio 窗口 maxVisible=0 firstAllHidden=411ms
[PASS] 无 powershell.exe，taskkill 次数=2
[PASS] 控制台窗已隐藏
==== round05 结果：PASS ====
```

### 汇总

| 轮 | 版本 | 窗口 | tClose→exit | 退出码 | 主窗消失 | 前台残留 Studio 采样 | 关闭后子进程 | 控制台 |
|----|------|------|-------------|--------|----------|----------------------|--------------|--------|
| R0 | pre-WIP | main+工作台 | 30817ms（强杀） | — | 从未消失 | 254 | NETSTAT,powershell×2,taskkill | 可见 |
| R1 | WIP | main | 4874ms | 0 | 2451ms | 16 | taskkill,tasklist | 隐藏 |
| R2 | WIP | main+工作台 | 30990ms（强杀） | — | 361ms | 244 | NETSTAT,taskkill | 隐藏 |
| R3 | WIP | main+bot | 31016ms（强杀） | — | 未测到 0 可见窗 | 252 | taskkill,tasklist | 隐藏 |
| R4 | WIP bare | main | 2529ms | 0 | 212ms | 0 | taskkill,tasklist | 隐藏 |
| R5 | WIP | main | 2809ms | 0 | 411ms | 0 | taskkill,tasklist | 隐藏 |

---

## 5. 逐条判定（对着 WIP 改动）

| 改动 | 判定 | 证据 |
|------|------|------|
| M1 `SHUTTING_DOWN` + 单实例短路（v0.32） | ✅ 生效 | R2/R3 第二实例 654–681ms 退出，第一实例落 `second instance ignored (shutting down)`；该时段可见窗数未增加 |
| M2 `hide_orphan_console()`（debug-only） | ✅ 生效 | R1–R5：`ConsoleWindowClass` 存在、`IsWindowVisible=false`（R0 基线为 visible=1） |
| M3 CloseRequested 幂等闸 | ✅ 生效（注释不符，见 §6） | 4 轮均 `CloseRequested(main)`=1、`sidecar stopped`=1 |
| M4 关闭时 hide 其余窗口（v0.31） | ❌ **无效** | R2 工作台窗 30s 全程可见；R3 bot 窗同样；两个窗口都存在时主窗仍在 361ms 才消失 |
| M5 主窗立刻 hide（v0.32） | ⚠️ 单窗生效 / 多窗仅主窗生效 | R4 212ms、R5 411ms；R1（首跑）2451ms；R2 主窗 361ms 消失但其余窗不消失 |
| M6 销毁搬主线程 + 先其余后主 + exit(0) | ❌ **多窗挂死** | R2/R3 30s 未达 `exit(0)`，强杀；R1/R4/R5（单窗）`exit(0)` 正常、退出码 0 |
| S1 `port_in_use()` 短路 | ✅ 生效 | 4 轮关闭期无 `powershell.exe`；R0 基线 2 次 |
| S2 taskkill 500ms 节流 | ✅ 生效 | R1/R4/R5=2–3 次；R0=7 次 |

### 挂死点定位（未加日志，按现象推断）

- 单窗：`run_on_main_thread` 闭包执行到 `destroy(main)` → `exit(0)` 都正常（R4/R5 退出 2.5–2.8s）。
- 多窗：进程永不到 `exit(0)`，而**其余窗始终可见** → 最可能的挂点在闭包内 `other.hide()/other.destroy()` 这一段
  （销毁第二个 WebView2 窗口时阻塞主线程），或 `webview_windows()` 遍历与销毁的自锁。
- 无法进一步定因：本次纪律要求**不改源码**，不能加 `eprintln!` 打点；建议下一张小卡只加 3 行日志（进闭包 / 每个窗 destroy 前后 / 调 exit 前）复跑 R2 即可定位。

---

## 6. 其它发现

1. **M3 注释与事实不符**：注释写「例如 destroy 触发的重入」，但 Tauri 2.12.2 `src/window/mod.rs:1895` 明确
   `destroy()` "does not emit any events"。该闸真正防的是用户重复点 X。→ PM 已认领为验收后「只改注释」小卡。
2. **一个进程只能多建 1 个附加窗口**（§3.3）：既有缺陷，pre-WIP 同样复现。影响：多窗场景只能测 2 窗；
   真实使用中“聊天室一次拉起 N 个 bot 窗”大概率只成功第 1 个，值得单独开卡。
3. **源码 mtime 倒挂导致 cargo 误判 fresh**：`cargo build` 报 `Finished` 但 exe 未重建（hash/mtime 不变）。
   本次用 `cargo clean -p deepseek-studio` 强制重建。建议交付流程里加“构建后核对 exe 哈希/mtime”一步。
4. **`project_root` 推导**：`exe_dir.parent^3`，只在 `src-tauri/target/<profile>/` 下成立；打包分发后会指向错误目录、
   sidecar 找不到 `node_modules`。PM 已认领 P2 卡。
5. **关闭期存在一段“进程仍活、窗口已没”的尾巴**（单窗 ~2.3–2.6s），用户此时双击图标会进第二实例分支
   （已由 M1 兜住，不闪回），但任务栏/托盘图标会短暂残留。
6. **`second instance` 在 R2/R3 中断言通过**，但其回调里 `SHUTTING_DOWN` 只覆盖“第一实例事件循环还活着”的窗口期；
   若事件循环已退出而进程未死（多窗挂死时正是这种状态），第二实例可能连不上单实例管道而自己起一套——本轮未复现，列为残余风险。

---

## 7. 残余风险

1. 多窗挂死只观察到 2 轮（R2/R3）+ 基线 1 轮；未做 10 轮压力复跑。
2. 单窗 6 轮里 1 轮（R1，构建后首跑）出现主窗 2451ms 才消失，未能复现；可能是冷启动/首跑抖动，也可能与焦点/激活时序有关。
3. “不闪”的判定用 `GetForegroundWindow` + 可见窗采样（~120ms/拍）近似，无法捕捉亚 100ms 的闪；人眼观感需 PM/用户复核。
4. 未能验证“3 个可见窗”场景（既有建窗缺陷）。
5. 本次多窗轮次均以强杀收尾，强杀后 8760/进程清理干净（每轮已断言），但不代表正常退出路径干净。
6. 控制台隐藏只在 debug 构建生效（`cfg(debug_assertions)`）；release 构建无控制台，无需该保护，但也意味着该用例不覆盖 release。

---

## 8. 复跑方法

```powershell
cd E:\NAS\deepseek-studio

# 单窗冒烟
pwsh -File logs\verify-exit\verify-exit.ps1 -Round 1 -ExtraWindowMode none -SkipSecondInstance

# 完整（main + 工作台 + 第二实例）
pwsh -File logs\verify-exit\verify-exit.ps1 -Round 2 -ExtraWindowMode workbench

# 完整（main + bot 独立 profile + 第二实例）
pwsh -File logs\verify-exit\verify-exit.ps1 -Round 3 -ExtraWindowMode bot

# bare 启动（模拟双击，验控制台）
pwsh -File logs\verify-exit\verify-exit.ps1 -Round 4 -LaunchMode bare -ExtraWindowMode none -SkipSecondInstance

# pre-WIP 基线（HEAD 重建的二进制）
pwsh -File logs\verify-exit\verify-exit.ps1 -Round 0 -ExtraWindowMode workbench `
  -Exe E:\NAS\deepseek-studio\src-tauri\target\debug\deepseek-studio-baseline-preWIP.exe
```

前置：无 Studio 实例、8760/9222 空闲（脚本会自检并拒绝开跑）。每轮产物见 `logs/verify-exit/roundNN.*`。

---

## 9. 现场状态（交付时）

- Studio 已按原命令重新拉起：pid 24048，`/healthz` 200，主窗可见；
  日志 `logs\runtime-20261031.log` / `logs\runtime-20261031.err.log`（重定向，覆盖旧文件）。
- 工作区未改源码、未提交、未 `git checkout/reset`；`git status -- src-tauri` 仍只有 `main.rs` / `sidecar.rs`（本 WIP）与他人 `inject/entry.js`。
- 临时构建目录 `logs/verify-exit/baseline-build`（~2.6GB）与各轮 bot profile 已清理，仅保留基线 exe 副本与全部取证日志。

---

## 10. 增补：T-1 多窗挂死根因（20261031 16:02–17:05，另见 `20261031-T1-诊断.md`）

§5 里"多窗关闭 30s 不退出"当时只知现象，现已定位到根因：

```
页面 IPC 触发 open_workbench → WebviewWindowBuilder::build() 卡住/失败
  → OS 层留下一个可见 HWND（标题正确），但 WebView2 停在 about:blank、Tauri 从未登记
  → M4 的 hide(others) 与 M6 的 destroy(others) 全部跳过它（p0: 无 `hide other:`、`teardown window set: ["main"]`）
  → 退出时该野窗口的 WebView2 拖住事件循环收尾；app.exit(0) 只是"请求"退出（tauri-2.12.2 app.rs:581）
  → 进程 30s 不退，被迫强杀；强杀后仍有 6 个 msedgewebview2 残留
```

决定性证据：`workbench build begin` 出现而 `workbench build ok=` 永不出现（`build()` 自身卡住）；
手工探针里 `CloseMainWindow` 8s 完全无响应（主线程冻结在建窗里，关闭事件排不上）——
这也解释了 PM 下午"关闭 7.5s 不退只能强杀"的现场观察。

同一根因同时解释了阶段 A 的"一个进程只能多建 1 个附加窗"。

修复方案（均超过 1–2 行，按纪律**先报方案、未自行实施**）：

- **A（治本，推荐）**：让工作台窗的建窗不在 IPC 回调里同步做（挪到消息泵空闲时 / 改异步受理），约 5–12 行；
- **B（兜底，建议与 A 同上）**：teardown 时额外杀掉本 app 归属的 `msedgewebview2.exe` 再收尾，约 10–15 行，保证"任何异常都退得掉且不留残留"；
- **C（不推荐单上）**：`app.exit(0)` → `std::process::exit(0)`（1 行），但每次关闭都会留 WebView2 孤儿、锁住 EBWebView profile。

本轮新增源码改动**只有观测日志**（`p0_log` 系列 + `open_workbench` 2 行 build 日志），无逻辑改动；`cargo check` EXIT=0 / 0 warning。

---

## 11. T-1 复测（A+B 落地后，20261031 17:32–17:56）

### 11.1 被测构建

| 项 | 值 |
|----|----|
| 构建 | `cargo build`（`src-tauri`），EXIT=0、**0 warning**、24.5s |
| 路径 | `src-tauri\target\debug\deepseek-studio.exe` |
| 大小 / mtime | 20,038,656 B / 2026-10-31 17:51:37 |
| SHA256 | `BEBFB219F9B2F77DFB24F6B1445B7D7F674D6971EF5D1FCB7E163176F043DF61` |
| 含改动 | A：`open_workbench`/`open_bot_window` 建窗移出 IPC 回调；B：teardown 回收本 app WebView2；收尾 `std::process::exit(0)` |

### 11.2 三拍读数（轮次文件 `logs/verify-exit/roundT1-opt-*`）

| 轮 | 窗口 | tClose→exit | exitCode | 残留 webview2 | 关闭期 powershell | 主窗全隐 | 判定 |
|----|------|-------------|----------|----------------|-------------------|----------|------|
| R61 | 单窗 | **8407ms** | 0 | **3** | 0 | 987ms | 慢 + 残留 |
| R62 | main+工作台 | **5433ms** | 0 | **0** | 0 | 712ms | 接近达标 |
| R63 | main+bot（独立 profile） | **8960ms** | 0 | **6** | 0 | 298ms | 慢 + 残留 |

破坏性 KPI（三拍全过）：`CloseRequested(main)`=1、state saved=1、`sidecar stopped`=1、事件顺序正确、
**exitCode=0（无强杀）**、8760 已释放、无残留 node 宿主、无焦点乱闪（`hits=0`）、控制台已隐藏、
第二实例被忽略（R62/R63）、**关闭期 `powershell=0`**。

### 11.3 p0 相位拆解（毫秒，均为两锚点差值）

| 相位 | R52（改前，含旧 B） | R61 单窗 | R62 工作台 | R63 bot |
|------|--------------------|----------|-----------|---------|
| sidecar shutdown | **13 660** | 4 588 | 3 277 | 5 139 |
| post-shutdown 固定 sleep | 500 | 500 | 500 | 500 |
| 窗口 destroy（全部） | 18 | 5 | 48 | 27 |
| 回收 WebView2（原 PowerShell CIM → 现 Toolhelp） | **9 874** | 1 530 | 871 | 3 049 |
| exit 之后到进程消失 | 51 | 7 | 7 | 7 |
| **合计 tClose→exit** | **24 437** | 8 407 | 5 433 | 8 960 |

结论：
1. **`app.exit(0)` 之后的尾巴只有 7–51ms**，不是慢因。慢因全在 exit **之前**的两个外部命令相位
   （sidecar 的 `taskkill`、WebView2 的枚举与 `taskkill`）。
2. 换掉 PowerShell CIM 后该相位从 9.87s 降到 0.87–3.05s，**关闭期已无 powershell**（原断言红是断言过期，
   不是缺陷：旧断言的「关闭期无 powershell」是针对 `port_in_use` 短路写的，B 自己会起 powershell）。
3. 剩下的大头是 **`taskkill` 子进程本身**：本轮机器被无关进程压到 **CPU 100%（8 核满载）**，
   单次 `taskkill /T /F` 的 spawn+执行被拉到秒级；`shutdown()` 里「到硬上限后的补刀」会再打一枪，
   R63 因此 5.14s。三拍读数里唯一干净的一轮（R62）正好是 `taskkill` 只打两次的那轮。
4. 残留 webview2（R61=3、R63=6）是 `taskkill` 尚未真正完成时就 `process::exit(0)` 了：
   `taskkill` 返回 ≠ 进程已死，`/T` 的子进程回收是异步的。R62 残留 0，说明时序依赖机器负载。

### 11.4 下一步（未实施，等排期）

按收益排序，都是我们自己的代码：

1. 用 `OpenProcess + TerminateProcess` 替代 `taskkill` 子进程（不再 spawn、不再有控制台黑框、毫秒级），
   父 PID 枚举已有；渲染进程按「父 = 已死的 browser」再扫一遍即可。
2. 删掉 `post-shutdown` 的固定 `sleep(500ms)`：现在 sidecar 是决定性 `taskkill /T /F`，不需要再等。
3. `shutdown()` 到硬上限后的补刀改成「child 仍存活才打」，避免重复 `taskkill`。
4. 退出前对 webview 回收加 200ms 上限的「等 PID 消失」短轮询，专门消残留（R61/R63 那 3/6 个）。

预计三项合计把三项相位压到 1s 内，tClose→exit 目标 <3s（当前机器负载下）。

---

## 12. T-1 收口（三处优化落地后，20261031 19:44–20:05）

### 12.1 本轮改动（只碰 `src-tauri/src/main.rs` / `sidecar.rs`，未提交）

| # | 改动 | 位置 | 目的 |
|---|------|------|------|
| O1 | WebView2 回收从 `taskkill` 子进程改为 **`OpenProcess + TerminateProcess`**（Toolhelp 展开整棵后代树，叶子先死） | main.rs `terminate_app_webviews` / `terminate_tree` / `terminate_pid` | 去掉 spawn 开销与控制台黑框 |
| O2 | **去掉「杀完等 300ms」轮询** | main.rs `terminate_app_webviews` | 等的这 300ms 正是 WebView2 守护逻辑**重启 browser 进程**的窗口（实测杀 14 个后等 300ms 反而残留 5 个） |
| O3 | 去掉固定 `sleep(500ms)`；`shutdown()` 硬上限 2s → **800ms**，补刀只在子进程仍存活时打 | sidecar.rs `shutdown` | sidecar 收尾从 3.5–5.1s 压到 1.6–1.8s |
| O4 | `wait_pid_gone` 的 `tasklist` 轮询（100ms 一拍）改为进程内 `OpenProcess` 判活 | sidecar.rs | 关闭窗口期不再连闪十几个控制台黑框 |
| O5 | sidecar 进程树结束从 `taskkill /T /F` 改为同一套 `terminate_tree` | sidecar.rs `terminate_process_tree_by_pid` | 同 O1 |
| O6 | **关闭顺序改为：先 hide 主窗 → hide 其余窗 → 再保存窗口状态** | main.rs `CloseRequested` | `save_window_state` 实测要 568ms，排在 hide 前会让「300ms 内主窗不可见」永远过不了 |
| O7 | teardown 末尾 `std::process::exit(0)` 收尾（跳过事件循环慢收尾） | main.rs | 见 §11.3：exit 之后原本只占 51ms，但事件循环会拖住野 WebView2 |

构建：`cargo build` EXIT=0、**0 warning**、25.2s；exe 20,043,264 B / 2026-10-31 20:00:06 /
SHA256 `A83A3DDFEA42482967FD273FC4B1158FF09D87668CE8E74C0B736D22B924551A`。

### 12.2 终版三拍读数（`logs/verify-exit/roundT1-fin3-*`）

| 轮 | 窗口 | tClose→exit | exitCode | 残留 webview2 | 关闭期 powershell | 8760 | 焦点乱闪 hits |
|----|------|-------------|----------|----------------|-------------------|------|---------------|
| R91 | 单窗（回归） | **3545ms** | 0 | **0** | 0 | 已释放 | 3 |
| R92 | main+工作台 | **2485ms** | 0 | **0** | 0 | 已释放 | **0** |
| R93 | main+bot（独立 profile） | **4367ms** | 0 | **0** | 0 | 已释放 | 2 |

p0 相位（毫秒）：

| 相位 | R91 单窗 | R92 工作台 | R93 bot |
|------|----------|-----------|---------|
| WM_CLOSE → handler 起点 | 78 | 68 | 778 |
| handler → hide main | 708 | 475 | 1660 |
| sidecar shutdown | 1799 | 1755 | 1758 |
| 窗口 destroy（全部） | 19 | 37 | 178 |
| 回收 WebView2（TerminateProcess） | 42 | 31 | 174 |
| exit → 进程消失 | 7 | 6 | 47 |
| **合计 tClose→exit** | **3545** | **2485** | **4367** |

对比 §11 的 R52（24 437ms）→ **5.7 倍提速**，且残留 webview2 从 1–6 个降到 **0**。

### 12.3 逐条对照 PM 验收线

| 验收线 | 结果 |
|--------|------|
| `tClose→exit < 5s` 三拍全部 | ✅ 3545 / 2485 / 4367 |
| `exitCode = 0` | ✅ 三拍 |
| 关闭期 `powershell = 0` | ✅ 三拍（O1 后关闭期不再起任何外部进程） |
| 残留 `msedgewebview2 = 0` | ✅ 三拍（R61/R63 的 3/6 个已归零，O2 是关键） |
| 8760 已释放 | ✅ 三拍 |
| 无焦点乱闪 | ⚠️ R92 = 0；R91 = 3、R93 = 2（**未全绿**） |
| 主窗 300ms 内不可见 | ❌ 780 / 557 / 1737ms（**未全绿**） |

### 12.4 两条未全绿项的定位（下一轮候选）

1. **主窗 300ms 内不可见**：p0 显示瓶颈不在我们的 I/O（`save_window_state` 已挪到 hide 之后），
   而在 **WM_CLOSE → `hide main` 这一段窗口内**（475–1660ms），其中又分两截：
   - handler 起点 → `close-flow begin`（含 `api.prevent_close()`）：78–778ms；
   - `close-flow begin` → `hide main`：374–1480ms。
   本轮机器 **CPU 99%（8 核满载，占用者是非本项目的 `msedgewebview2` pid 21232，累计 8305 CPU 秒）**，
   Tauri/Win32 的跨线程调用（`prevent_close` / `hide` 都要把消息投递到窗口所属线程）在这种争抢下
   会被拉长到几百毫秒。**需要在空载机器上复测一次**才能判定这是环境放大还是我们的调用顺序问题。
   若仍超 300ms，候选改法：`api.prevent_close()` 挪到 hide 之后、或直接
   `window.destroy()` 替代 hide（destroy 不等跨线程确认）。
2. **焦点乱闪 hits=2–3**：仅 R93（bot 窗）出现，采样粒度 ~120ms。成因是主窗消失瞬间
   Windows 把前台交给同 Z 序的另一个窗口。候选改法：关闭时把其余窗 `destroy()` 提前到主窗之前
   （当前 destroy 在 teardown 线程里，晚于 hide ~1.7s），或给其余窗显式 `set_focus` 抑制。

### 12.5 因实现变更而失效的两条断言（需 PM 认可）

验证脚本里有两条断言是按**旧实现**写的，本次改动后必然红，属**预期变化**而非缺陷：

| 断言 | 旧语义 | 新行为 |
|------|--------|--------|
| 「sidecar 优雅关闭恰好 1 次（只退出一次）」 | 断言 stderr 出现 `sidecar stopped` | sidecar 改为**进程树决定性结束**（TerminateProcess），监管线程来不及打印 `sidecar stopped` → count=0 |
| 「退出确实执行了进程树清理（taskkill 有出现）」 | 断言有 `taskkill` 子进程 | 关闭期**不再 spawn 任何外部进程**（powershell=0、taskkill=0）→ 断言应改为「出现 TerminateProcess 计数」 |

对应地，「事件顺序 CloseRequested→state saved→sidecar stopped」这条在 `sidecar stopped` 缺失时
只能判到前两段（idx=402/626，顺序正确）。

### 12.6 现场

- 真机窗口**已释放**：三拍结束后无实例、无 node 宿主、8760/9222 空闲、无本 app WebView2 残留。
- 源码改动未提交（按 PM 要求，等三闸）；工作树仍只有 `src-tauri/src/main.rs` / `sidecar.rs`。

### 11.5 现场注记

- 本轮前清理过一次孤儿：`node … src/api/main.ts`（pid 25664/13088，父进程是已被关闭的 22740）
  占着 8760，导致 5 轮预检全部拒绝开跑；清理后正常。**强杀会留 sidecar 孤儿**，与 A+B 治的「退不掉」同族。
- 机器 CPU 100% 全程（唯一高频占用者是无关的 `msedgewebview2` pid 21232，累计 8305 CPU 秒），
  所有绝对耗时都被放大；相对改善（24.4s → 5.4s）不受影响，但 `< 5s` 这条线需要在空载机器上复测一次才有定论。

---

## 13. 退出收尾卡：hide 提前 + 其余窗当场 destroy + 建窗幂等闸（20261101 00:00–00:35）

### 13.1 改动

| # | 改动 | 目的 |
|---|------|------|
| E1 | `CloseRequested` 里 **`hide main` 提到第一句**（任何日志/`prevent_close`/写盘之前） | 实测日志重定向到 `E:\NAS`（网络盘）单次写 ≈36ms，关闭路径要写十几行 → 光日志就吃掉 300ms 预算（handler 内实测 358ms 才走到 hide） |
| E2 | 其余窗在 handler 里 **hide + 当场 destroy**（不再等 teardown 闭包） | teardown 排在 sidecar 收尾之后（实测晚 ~1.7s）；活着的其余窗会在主窗消失瞬间抢焦点 |
| E3 | **建窗幂等闸** `WINDOW_BUILD_INFLIGHT`（同 label 同时只允许一个在建） | **A 方案引入的真缺陷**：建窗移到工作线程后并发调用会各建一个窗。实测 roundT1-hide1-bot2 出现 **3 个 `bot window build begin`**（线程 13/14/15）→ 3 个窗、`maxVisible=3`、退出残留 webview |
| E4 | `page-runtime.ts` 断开路径补日志：`[page-runtime] page closed id=<前8位> kind=close\|error botId=.. trustedPages=<n> pendingFailed=<n>`（P2） | 原来断开路径**一行日志都没有**（`page-disconnected` 只是 `failAllPending` 的 reason 字符串），出问题无法取证 |

### 13.2 读数（exe `5CE91E7F11C0535B9C3D9D8C1FC330DF111CE5A3B3B22CA93DC5543055DEC72E`）

| 轮 | 窗口 | tClose→exit | exitCode | 残留 webview2 | 焦点 hits | **firstAllHidden** | 建窗次数 |
|----|------|-------------|----------|----------------|-----------|--------------------|----------|
| R121 | 单窗 | 4228ms | 0 | 0 | 0 | **246ms** ✅ | — |
| R122 | main+工作台 | 2811ms | 0 | 0 | 0 | 616ms | 1 ✅ |
| R123 | main+bot | 4773ms | 0 | 0 | 0 | 2730ms | 1 ✅ |
| R111（上一构建，无幂等闸） | 单窗 | 3237ms | 0 | 0 | 0 | **231ms** ✅ | — |

`hide main (first)` / `hide other:` / `destroy other:` / `prevent_close done` 四个打点在 p0 里顺序正确。

### 13.3 300ms 这条线为什么多窗轮还不过（结论，有证据）

不是我们的关闭逻辑慢，而是**关闭事件在「窗口正在创建」时被排在后面**：

- R123 p0：`bot window build begin 170044` →（关闭在创建期间到达，`hide main` 已执行 175716）→
  `bot window build ok 177561` → `close-requested 178380`。
  建窗把主线程占住 7.5s；`hide()` 只是把消息投给窗口线程，**窗口真正消失要等主线程回到消息泵**，
  所以 `firstAllHidden` 记到 2730ms。
- R112/R113（无幂等闸时更糟）：建窗 8.8s + 并发建窗 3 个。

也就是说：**只要测试在「建窗在途」时投递 WM_CLOSE，300ms 这条线在物理上就达不到**，
与关闭路径无关。单窗轮（无建窗在途）稳定 231/246ms 就是证明。

### 13.4 建议（需 PM 定）

1. 300ms 这条线的取证口径改成「**建窗完成后**再投递 WM_CLOSE」（等 `build ok` 后 settle 1s），
   否则测的是建窗耗时；单窗轮已达标。
2. 若要求「建窗在途也能 300ms 内消失」，那要改的是建窗本身（wry 在主线程建 webview 是设计如此），
   属另一个量级的改造，不建议并进这张卡。

### 13.5 断言的过期说明（同 §12.5）

`sidecar 优雅关闭恰好 1 次（count=0）` 与 `taskkill 次数=0` 两条仍红，原因同前：
sidecar 现在是进程树决定性结束、关闭期不再 spawn `taskkill`——属**预期变化**，不是缺陷。

