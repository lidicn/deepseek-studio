# 真机操作手册 · 席5 专用

> 2026-10-17 13:00 | PM 写
> 席5 拿到这个手册就知道怎么操作真实环境

---

## 第一步：启动 Studio

```bash
cd E:\NAS\deepseek-studio
npm run tauri:dev
```

**等什么**：Tauri 编译完，会弹出一个桌面窗口。窗口里加载的是 DeepSeek 网页（不是本地 UI）。

**如果报错**：
- `cargo` 不存在 → 需要装 Rust 工具链
- `tauri` 命令不存在 → 先 `npm install`
- 端口被占 → 关掉其他 Tauri 实例

## 第二步：登录 DeepSeek

在弹出的窗口里：
1. 看到 DeepSeek 登录页
2. 用户已经登录过的话会直接进对话页
3. 如果没登录，需要用户手动扫码/输入账号

**席5 不要自己登录**，等用户说"已经登录好了"再继续。

## 第三步：确认 WebEngine 能连上

登录后，在终端跑：

```bash
npx tsx tools/metrics/live-health.ts
```

如果这个脚本不存在，席5 自己写一个最小版：
- import createWebEngine
- 调 engine.health()
- 打印结果

**预期**：health() 返回 `{ ok: true }`。

如果返回 `{ ok: false }`：
- reason 含 'disconnected' → 网页没加载完，等 10 秒再试
- reason 含 'crashed' → 窗口崩了，重启
- reason 含 'timeout' → 注入脚本没跑，检查 build:inject

## 第四步：跑验收

确认 health ok 后，按 V1→V2→V3→V4→V5 顺序跑。

**关键**：每一步跑完落 progress 文件，再做下一步。不要一口气全跑完不写记录。

---

## 常见问题

| 问题 | 解决 |
|---|---|
| tauri:dev 编译报错 | 贴错误给 PM，不要自己改 cargo 文件 |
| 窗口弹出来但白屏 | 等 30 秒，DeepSeek 网页加载慢 |
| health() 一直 false | 跑 `npm run build:inject` 再重启 |
| send() 超时 | 检查网络/登录态 |
| 不知道当前在哪个阶段 | 看 progress/ 目录最新文件 |

---

## 不要做的事

- 不要自己写业务代码
- 不要改 kernel/engine/harness 的运行时逻辑
- 不要关窗口
- 不要同时跑多个 tauri:dev
- 遇到问题先写 progress 文件，再继续
