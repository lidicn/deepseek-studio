//! v0.12 Phase 1 · sidecar 受监管进程管理层
//!
//! DCD 20261011-DPP-v0.12 四条修正条件的 Rust 侧落地：
//! 1. 持 Child 句柄，try_wait() 轮询退出（⛔ 不得 fire-and-forget）
//! 2. 健康检查打 GET /healthz（不是 /health）
//! 3. 孤儿防护落在 Node 侧（src/api/main.ts，本文件不涉及）
//! 4. 重启预算写死：崩溃后 2s 重启，最多 5 次；超预算 GaveUp

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// ── 契约常量（⛔ DCD 禁改：端口 / 端点）──────────────────────────────
pub const HEALTH_HOST: &str = "127.0.0.1";
pub const HEALTH_PORT: u16 = 8760;
pub const HEALTH_PATH: &str = "/healthz";

// ── 时间预算（DCD 写死）───────────────────────────────────────────────
pub const STARTUP_HEALTH_TIMEOUT: Duration = Duration::from_secs(60);
pub const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(100);
pub const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
pub const RESTART_DELAY: Duration = Duration::from_secs(2);
pub const MAX_RESTARTS: u8 = 5;
pub const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(5);

/// src/api/main.ts 在 EADDRINUSE 时使用的退出码（见该文件 host.start() catch 分支）。
/// 两侧必须一致：改这里就得改那边，改那边就得改这里。
pub const SIDECAR_EXIT_PORT_CONFLICT: i32 = 2;

// ── 状态机 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarState {
    Spawning,
    Running,
    Crashed(String),
    Restarting(u8),
    GaveUp,
    Stopped,
    /// 启动期确定性失败（端口占用 / 依赖缺失 / 配置错误）。
    ///
    /// 与 Crashed 的区别：Crashed 是「运行中意外退出」，值得退避重启；
    /// StartupFailed 是「同样的输入再跑一次必然同样失败」，重启只是刷屏。
    /// 典型：src/api/main.ts 撞 EADDRINUSE 后 process.exit(2)。
    StartupFailed(String),
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum SidecarEvent {
    StateChange {
        state: String,
        restarts: u8,
        pid: Option<u32>,
    },
    Crash {
        reason: String,
        restarts: u8,
    },
    GaveUp {
        crashes: u8,
    },
    /// 启动期确定性失败，不进重启预算（重试也无意义）。
    FatalStartup {
        reason: String,
    },
}

// ── 健康检查 ───────────────────────────────────────────────────────────

fn probe_health() -> bool {
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
        HEALTH_PATH, HEALTH_HOST, HEALTH_PORT
    );
    // parse() 失败时优雅返回 false，不 panic（防御性编程：常量未来可能改动态配置）
    let addr = match format!("{}:{}", HEALTH_HOST, HEALTH_PORT).parse() {
        Ok(a) => a,
        Err(_) => {
            eprintln!("[sidecar] health probe: failed to parse address");
            return false;
        }
    };
    TcpStream::connect_timeout(&addr, HEALTH_PROBE_TIMEOUT)
        .ok()
        .and_then(|mut stream| {
            stream.set_read_timeout(Some(HEALTH_PROBE_TIMEOUT)).ok()?;
            stream.write_all(request.as_bytes()).ok()?;
            let mut buf = [0u8; 64];
            let n = stream.read(&mut buf).ok()?;
            if n == 0 {
                // 服务端立即关闭连接 → 不健康
                return Some(false);
            }
            let response = String::from_utf8_lossy(&buf[..n]);
            Some(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
        })
        .unwrap_or(false)
}

/// 8760 端口上是否仍有人监听（只做 TCP 连通判断，不要求 HTTP 200）。
///
/// 用途：关闭时判断是否还需要跑 `netstat` / PowerShell CIM 这些昂贵兜底。
/// 端口已经空闲就说明宿主彻底没了，没必要再花 1~2s 扫进程表。
fn port_in_use() -> bool {
    match format!("{}:{}", HEALTH_HOST, HEALTH_PORT).parse() {
        Ok(addr) => TcpStream::connect_timeout(&addr, HEALTH_PROBE_TIMEOUT).is_ok(),
        Err(_) => false,
    }
}

fn terminate_process_tree_by_pid(pid: u32) {
    #[cfg(windows)]
    {
        // 20261031：改为进程内 `OpenProcess + TerminateProcess` 枚举结束整棵树
        // （见 main.rs `terminate_tree`）。原来每次 `taskkill /T /F` 都要 spawn 一个
        // 子进程 + 一个控制台窗口：实测在负载机器上单次要 1~3s，且每次都闪一下黑框
        // ——「关闭慢」和「关闭乱闪」两个用户抱怨都指向这一行。
        // terminate_tree 会先按 Toolhelp 展开后代（tsx CLI 会把真正跑宿主的 node
        // 作为孙进程 fork 出来），叶子先死、父进程后死，300ms 内等 PID 真正消失。
        let _ = crate::terminate_tree(pid);
        // 端口已空闲说明宿主彻底没了 → 没必要再跑一次 netstat 全表扫描。
        // 实测那一步在负载机器上要 1~2s，且会闪一个控制台黑框。
        if port_in_use() {
            terminate_listener_on_port(HEALTH_PORT);
        }
    }
    #[cfg(not(windows))]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
}

/// 强制结束 sidecar 及其全部子进程。
///
/// Windows 下 `Child::kill()` 只结束 `cmd.exe` 包装进程，`npx` 启动的
/// `node.exe` 会继续占用 8760 端口。必须按 PID 结束整棵进程树。
fn force_kill_process_tree(child: &mut Child) {
    let pid = child.id();
    terminate_process_tree_by_pid(pid);
    // taskkill 是异步的，Rust 侧进程表更新有延迟；等整棵树真的消失再返回，
    // 否则 do_spawn 紧接着重启时端口可能还没释放。
    wait_pid_gone(pid, Duration::from_secs(3));
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// 结束仍在本机端口上 LISTENING 的进程（taskkill /T 的兜底）。
///
/// ⚠️ 实测局限（20261023）：本机 netstat -ano / Get-NetTCPConnection 对部分
/// socket 返回 OwningProcess=0（已复现：18766 / 11818 / 11292 / 8760 均如此），
/// 所以「按 PID 反查补刀」这条路在这里不可靠，只能作为次级兜底。
/// 真正可靠的是 terminate_host_by_cmdline()：按命令行特征直接定位 node.exe，
/// 不经过 TCP 表。
#[cfg(windows)]
fn terminate_listener_on_port(port: u16) {
    // netstat -ano 输出里 LISTENING 行的最后一列是 PID。
    let needle = format!(":{}", port);
    if let Ok(out) = Command::new("netstat").args(["-ano"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.contains(&needle) || !trimmed.contains("LISTENING") {
                continue;
            }
            if let Some(pid) = trimmed.split_whitespace().last() {
                let _ = Command::new("taskkill")
                    .args(["/PID", pid, "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
}

#[cfg(not(windows))]
fn terminate_listener_on_port(_port: u16) {}

/// 按命令行特征结束所有跑 studio 宿主的 node 进程。
///
/// 这是端口兜底不可靠（OwningProcess=0）时的主路径。用 PowerShell CIM 查询
/// 而非 netstat，因为后者拿不到 PID。只匹配同时含 tsx CLI 与 main.ts 的
/// node.exe，避免误伤同机的其它 node 进程（如 dpp-bridge、playwright mcp）。
#[cfg(windows)]
fn terminate_host_by_cmdline() {
    // -Filter 用 WQL，两个条件都要满足才算宿主进程。
    let script = concat!(
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ",
        "Where-Object { $_.CommandLine -like '*tsx*dist*cli.mjs*' -and $_.CommandLine -like '*api/main.ts*' } | ",
        "ForEach-Object { Write-Output $_.ProcessId }"
    );
    if let Ok(out) = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Ok(pid) = line.trim().parse::<u32>() {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
}

#[cfg(not(windows))]
fn terminate_host_by_cmdline() {}

/// 轮询等待 PID 彻底消失，最多 `budget`。进程不存在即视为已消失（查询报错）。
///
/// 20261031：原来每次轮询都 spawn 一次 `tasklist`（100ms 一拍）→ 关闭窗口期会连闪
/// 十几个控制台黑框，正是用户抱怨的「关闭时乱闪」。改为进程内 `OpenProcess` 判活。
#[cfg(windows)]
fn wait_pid_gone(pid: u32, budget: Duration) {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if !crate::pid_alive(pid) {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(windows))]
fn wait_pid_gone(_pid: u32, _budget: Duration) {}

// ── TD-04：宿主入口形态与 node 解析 ─────────────────────────────────────

/// 宿主入口形态。
///
/// 旧实现只有一种：`node node_modules/tsx/dist/cli.mjs src/api/main.ts` —— 它要求
/// **目标机**同时具备 ① PATH 里有 node ② 安装目录里有 node_modules/tsx。
/// tsx 在 devDependencies 里，打包根本不带 → 安装版宿主起不来。
/// 现在：打包版跑随包分发的单文件 `<resource_dir>/host/main.mjs`；
/// tsx 只在**开发构建**且宿主编译产物缺失时回退，且必须打 WARN。
pub enum HostEntry {
    /// 打包版：`node <script>`，并把 STUDIO_RESOURCE_ROOT 指到 resource_root。
    Bundled { script: PathBuf, resource_root: PathBuf },
    /// 开发回退：`node <project_root>/node_modules/tsx/dist/cli.mjs <project_root>/src/api/main.ts`。
    Tsx { project_root: PathBuf },
}

/// 找不到可用 Node.js 时的专用退出码（TD-04）。
pub const EXIT_NODE_MISSING: i32 = 21;
/// 打包版找不到宿主单文件时的专用退出码（TD-04）。
pub const EXIT_HOST_MISSING: i32 = 22;

/// node 可执行文件：`STUDIO_NODE` 优先，否则 PATH 里的 `node`。
pub fn node_executable() -> String {
    std::env::var("STUDIO_NODE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "node".to_string())
}

/// 启动前探活：`<node> --version` 跑通才算可用。
///
/// 不可用时**不重试**：监管线程的重启逻辑对「没有 node」只会无限刷屏，
/// 由调用方给专用退出码（EXIT_NODE_MISSING）并提示安装 Node.js ≥24。
pub fn probe_node() -> Result<(), String> {
    let node = node_executable();
    let mut cmd = Command::new(&node);
    cmd.arg("--version").stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        win_creation_flags(&mut cmd);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(format!("`{node} --version` 退出码 {:?}", out.status.code())),
        Err(e) => Err(format!("无法执行 `{node}`：{e}")),
    }
}

/// CREATE_NO_WINDOW：GUI 父进程拉 console 子进程时不弹黑框（与 spawn_child 同一套路）。
#[cfg(windows)]
fn win_creation_flags(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

// ── 监管主体 ───────────────────────────────────────────────────────────

pub struct SidecarSupervisor {
    state: SidecarState,
    child: Option<Child>,
    restarts: u8,
    /// TD-04：宿主入口（打包单文件 / dev tsx 回退）。
    host_entry: HostEntry,
    event_tx: Sender<SidecarEvent>,
    shutdown_requested: Arc<AtomicBool>,
    child_pid: Arc<AtomicU32>,
    crash_log_path: Option<PathBuf>,
}

impl SidecarSupervisor {
    pub fn new(
        host_entry: HostEntry,
        event_tx: Sender<SidecarEvent>,
        shutdown_requested: Arc<AtomicBool>,
        child_pid: Arc<AtomicU32>,
    ) -> Self {
        let crash_log_path = std::env::var("STUDIO_LOG_DIR")
            .ok()
            .map(PathBuf::from)
            .or_else(|| dirs::config_dir().map(|d| d.join("deepseek-studio").join("logs")));
        if let Some(ref p) = crash_log_path {
            let _ = std::fs::create_dir_all(p);
        }
        Self {
            state: SidecarState::Spawning,
            child: None,
            restarts: 0,
            host_entry,
            event_tx,
            shutdown_requested,
            child_pid,
            crash_log_path,
        }
    }

    fn spawn_child(&mut self) -> std::io::Result<Child> {
        // P0-1：绕过 npx/npm CLI 直接调本地 tsx。
        //
        // 旧命令 `cmd /c npx tsx src/api/main.ts` 在这台机器上冷启动就绪要
        // 12.7–41.2 秒（20261023 实测，见 docs/审计报告/
        // Studio-启动崩溃根因诊断-20261023.md §3.3）：npx 要拉起完整 npm CLI，
        // 而宿主自己的模块图只要 1.5 秒。10 秒健康预算必然等不到 → 6 连
        // health timeout → gave up → 宿主永久缺席。
        //
        // 直连 `node node_modules/tsx/dist/cli.mjs` 实测 4.6 秒就绪。
        // 附带好处：子进程直接是 node.exe，`taskkill /T /F` 能覆盖 tsx 派生链，
        // 修掉「杀树不干净 → 残留 node 占 8760 → 下一轮 EADDRINUSE」。
        // TD-04：入口由 main.rs 解析后传入（打包版 Bundled，dev 回退 Tsx）。
        // node 解析：STUDIO_NODE → PATH；不可用时 main.rs 已用专用退出码拦下。
        let node = node_executable();
        let mut cmd = match &self.host_entry {
            HostEntry::Bundled { script, resource_root } => {
                let mut c = Command::new(&node);
                c.arg(script);
                // 宿主据此找静态资源：<res>/src/ui/agent.html、<res>/dist/agent-panel.js。
                // 安装版 resource_dir() 与开发树仓库根**目录结构同构**，宿主无须区分两种形态。
                c.env("STUDIO_RESOURCE_ROOT", resource_root);
                c.current_dir(resource_root);
                c
            }
            HostEntry::Tsx { project_root } => {
                let mut c = Command::new(&node);
                // 旧路径（仅 dev 回退）：直连本地 tsx，绕过 npx/npm CLI
                // （冷启动 12.7–41.2s → 4.6s，见本文件上方注释）。
                if cfg!(windows) {
                    c.args(["./node_modules/tsx/dist/cli.mjs", "src/api/main.ts"]);
                } else {
                    c.args(["node_modules/tsx/dist/cli.mjs", "src/api/main.ts"]);
                }
                c.current_dir(project_root);
                c
            }
        };
        cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());

        // ① 运行时日志落盘（路线图 §12 第 7 项）：
        // 原来只有崩溃时写 crash.jsonl，运行时 stdout/stderr **全丢**——GUI 启动（不重定向）时
        // sidecar 一条日志都不剩，「出问题没法查」的根因之一。
        // 这里把子进程 stdout/stderr 落到 `<log_dir>/sidecar-<epoch_ms>.log`（按次命名），
        // 并在启动时把路径打一行到 stderr 便于定位。
        if let Some(ref log_dir) = self.crash_log_path {
            let _ = std::fs::create_dir_all(log_dir);
            let path = log_dir.join(format!("sidecar-{}.log", chrono_now_ms()));
            match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                Ok(f) => {
                    let cloned = f.try_clone();
                    cmd.stdout(Stdio::from(f));
                    match cloned {
                        Ok(f2) => {
                            cmd.stderr(Stdio::from(f2));
                        }
                        Err(e) => {
                            eprintln!("[studio] WARN: sidecar stderr clone failed: {e}");
                            cmd.stderr(Stdio::inherit());
                        }
                    }
                    eprintln!("[studio] sidecar runtime log: {}", path.display());
                }
                Err(e) => {
                    eprintln!(
                        "[studio] WARN: sidecar log open failed: {e} (fallback to inherit)"
                    );
                }
            }
        }

        // 不弹黑框：GUI 进程拉起 console 程序（node）时要显式 CREATE_NO_WINDOW。
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.spawn()
    }

    fn write_crash_log(&self, reason: &str) {
        if let Some(ref log_dir) = self.crash_log_path {
            let log_file = log_dir.join("crash.jsonl");
            let entry = format!(
                "{{\"ts\":{},\"restarts\":{},\"reason\":\"{}\"}}\n",
                chrono_now_ms(),
                self.restarts,
                reason.replace('"', "\\\"").replace('\n', "\\n")
            );
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_file)
            {
                let _ = f.write_all(entry.as_bytes());
            }
        }
    }

    fn emit(&self, event: SidecarEvent) {
        let _ = self.event_tx.send(event);
    }

    fn is_shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }

    fn set_state(&mut self, new_state: SidecarState) {
        let state_str = match &new_state {
            SidecarState::Spawning => "spawning",
            SidecarState::Running => "running",
            SidecarState::Crashed(_) => "crashed",
            SidecarState::Restarting(_) => "restarting",
            SidecarState::GaveUp => "gave-up",
            SidecarState::Stopped => "stopped",
            SidecarState::StartupFailed(_) => "startup-failed",
        };
        let pid = self.child.as_ref().and_then(|c| {
            #[cfg(unix)]
            {
                Some(c.id())
            }
            #[cfg(windows)]
            {
                Some(c.id())
            }
        });
        self.emit(SidecarEvent::StateChange {
            state: state_str.to_string(),
            restarts: self.restarts,
            pid,
        });
        self.state = new_state;
    }

    /// 主循环：在独立线程中运行，阻塞直到 Stopped 或 GaveUp。
    pub fn run(&mut self) {
        loop {
            match self.state.clone() {
                SidecarState::Spawning => {
                    self.do_spawn();
                }
                SidecarState::Running => {
                    self.do_monitor();
                }
                SidecarState::Crashed(reason) => {
                    self.do_crash(&reason);
                }
                SidecarState::Restarting(n) => {
                    self.do_restart_cooldown(n);
                }
                SidecarState::GaveUp | SidecarState::Stopped | SidecarState::StartupFailed(_) => {
                    return;
                }
            }
            if self.is_shutdown_requested() && !matches!(self.state, SidecarState::Stopped) {
                self.do_shutdown();
                return;
            }
        }
    }

    fn do_spawn(&mut self) {
        // W3（20261023）：首次启动前先扫一遍上一次进程留下的宿主。
        //
        // 主程序被强杀（任务管理器 / Stop-Process / 崩溃）时 do_shutdown 不会跑，
        // node 宿主会变成孤儿并继续占着 127.0.0.1:8760；下次启动再拉起一个 →
        // EADDRINUSE → 新宿主立刻 exit(2) → 表现为启动瞬间「sidecar crash #1..#6,
        // gave up」。这正是用户实测到的「主程序已退出但 npx/node 进程还活着，
        // 后来主程序又启动导致冲突」。
        //
        // 只在首轮（restarts == 0）扫：重试轮里 self.child 可能正在启动，
        // 无条件扫会把它一起误杀。
        if self.restarts == 0 {
            terminate_host_by_cmdline();
        }
        let spawn_result = self.spawn_child();
        match spawn_result {
            Ok(child) => {
                self.child_pid.store(child.id(), Ordering::SeqCst);
                self.child = Some(child);
                let start = Instant::now();
                // 等待 /healthz 就绪，最多 10s
                while start.elapsed() < STARTUP_HEALTH_TIMEOUT {
                    if probe_health() {
                        self.set_state(SidecarState::Running);
                        return;
                    }
                    thread::sleep(EXIT_POLL_INTERVAL);
                    if self.is_shutdown_requested() {
                        self.do_shutdown();
                        return;
                    }
                }
                // 健康超时。首次启动（restarts==0）时先看一眼端口是否已被别人占着：
                // EADDRINUSE 会让 main.ts 立刻 exit(2)，属于确定性失败，重试无意义。
                if let Some(mut child) = self.child.take() {
                    force_kill_process_tree(&mut child);
                }
                self.child_pid.store(0, Ordering::SeqCst);
                let reason = format!("health timeout after {:?}", STARTUP_HEALTH_TIMEOUT);
                if self.restarts == 0 && probe_health() {
                    // 杀掉子进程后端口仍有人应答 → 端口被外部进程占用。
                    let reason = format!(
                        "port {} already in use by another process (local API failed to bind)",
                        HEALTH_PORT
                    );
                    self.set_state(SidecarState::StartupFailed(reason.clone()));
                    self.write_crash_log(&reason);
                    self.emit(SidecarEvent::FatalStartup { reason });
                    return;
                }
                // health timeout 且端口确实没人应答 → 上一轮的宿主其实起来了、
                // 只是慢，而它现在已经不在我们管的 child 句柄里（被杀过一轮）。
                // 按命令行清一次，避免它变成下一轮的端口占用者。
                terminate_host_by_cmdline();
                self.set_state(SidecarState::Crashed(reason.clone()));
                self.write_crash_log(&reason);
                self.emit(SidecarEvent::Crash {
                    reason,
                    restarts: self.restarts,
                });
            }
            Err(e) => {
                // 连进程都起不来（npx 不存在 / 权限拒绝 / 路径错）：重试同样起不来。
                let reason = format!("spawn failed: {}", e);
                self.child_pid.store(0, Ordering::SeqCst);
                self.set_state(SidecarState::StartupFailed(reason.clone()));
                self.write_crash_log(&reason);
                self.emit(SidecarEvent::FatalStartup { reason });
            }
        }
    }

    fn do_monitor(&mut self) {
        loop {
            thread::sleep(EXIT_POLL_INTERVAL);
            if self.is_shutdown_requested() {
                self.do_shutdown();
                return;
            }
            if let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.child = None;
                        self.child_pid.store(0, Ordering::SeqCst);
                        if self.is_shutdown_requested() {
                            self.set_state(SidecarState::Stopped);
                            return;
                        }
                        // src/api/main.ts 的 EADDRINUSE 分支固定 exit(2)（见 main.ts:250）。
                        // 这是确定性失败：只要占用方不退出，重启多少次都同样撞端口。
                        // 特判它，否则用户看到的是 5 轮 crash/restart 刷屏而非真实原因。
                        if status.code() == Some(SIDECAR_EXIT_PORT_CONFLICT) {
                            let reason = format!(
                                "local API port {} is already in use; close the process holding it, or change port in config.json",
                                HEALTH_PORT
                            );
                            self.set_state(SidecarState::StartupFailed(reason.clone()));
                            self.write_crash_log(&reason);
                            self.emit(SidecarEvent::FatalStartup { reason });
                            return;
                        }
                        let reason = format!("process exited with status {:?}", status);
                        self.set_state(SidecarState::Crashed(reason.clone()));
                        self.write_crash_log(&reason);
                        self.emit(SidecarEvent::Crash {
                            reason,
                            restarts: self.restarts,
                        });
                        return;
                    }
                    Ok(None) => continue,
                    Err(_) => continue,
                }
            }
        }
    }

    fn do_crash(&mut self, _reason: &str) {
        if self.restarts >= MAX_RESTARTS {
            self.set_state(SidecarState::GaveUp);
            self.emit(SidecarEvent::GaveUp {
                crashes: self.restarts + 1,
            });
            eprintln!(
                "[sidecar] gave up after {} crashes, no more auto-restart",
                self.restarts + 1
            );
            return;
        }
        self.restarts += 1;
        self.set_state(SidecarState::Restarting(self.restarts));
    }

    fn do_restart_cooldown(&mut self, n: u8) {
        eprintln!(
            "[sidecar] crash #{}, restarting in {:?}...",
            n, RESTART_DELAY
        );
        let start = Instant::now();
        while start.elapsed() < RESTART_DELAY {
            thread::sleep(EXIT_POLL_INTERVAL);
            if self.is_shutdown_requested() {
                self.do_shutdown();
                return;
            }
        }
        self.set_state(SidecarState::Spawning);
    }

    fn do_shutdown(&mut self) {
        self.shutdown_requested.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            {
                // 尝试 SIGTERM
                unsafe {
                    libc::kill(child.id() as i32, libc::SIGTERM);
                }
            }
            #[cfg(windows)]
            {
                // Windows: cmd.exe 只是包装层，必须连同 node.exe 子树一起结束。
                force_kill_process_tree(&mut child);
            }
            let start = Instant::now();
            while start.elapsed() < GRACEFUL_TIMEOUT {
                if let Ok(Some(_)) = child.try_wait() {
                    break;
                }
                thread::sleep(EXIT_POLL_INTERVAL);
            }
            // 超时强杀
            let _ = child.kill();
            let _ = child.wait();
            // 强杀之后同样兜底：taskkill /T 覆盖不到 tsx fork 出的孙进程。
            // v0.32：端口已空闲就跳过这两步（单次 1~2s，是退出慢的主因）。
            if port_in_use() {
                terminate_listener_on_port(HEALTH_PORT);
                terminate_host_by_cmdline();
            }
        }
        self.child_pid.store(0, Ordering::SeqCst);
        // 兜底：无论上面哪条路径，退出前确认 8760 真的没人听了。
        // 否则下次启动的宿主会撞 EADDRINUSE → exit(2) → StartupFailed。
        // 端口兜底读不到 OwningProcess=0 的 socket，命令行兜底才是主路径。
        if port_in_use() {
            terminate_host_by_cmdline();
            terminate_listener_on_port(HEALTH_PORT);
        }
        self.set_state(SidecarState::Stopped);
        eprintln!("[sidecar] stopped (graceful shutdown)");
    }
}

// ── 对外句柄 ───────────────────────────────────────────────────────────

pub struct SidecarHandle {
    shutdown_requested: Arc<AtomicBool>,
    child_pid: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
}

impl SidecarHandle {
    pub fn start(host_entry: HostEntry) -> (Self, Receiver<SidecarEvent>) {
        let (event_tx, event_rx) = mpsc::channel::<SidecarEvent>();
        let shutdown_requested = Arc::new(AtomicBool::new(false));
        let child_pid = Arc::new(AtomicU32::new(0));
        let stopped = Arc::new(AtomicBool::new(false));

        let supervisor = Arc::new(Mutex::new(SidecarSupervisor::new(
            host_entry,
            event_tx,
            shutdown_requested.clone(),
            child_pid.clone(),
        )));

        // 监管线程
        let sup_clone = supervisor.clone();
        let stopped_clone = stopped.clone();
        thread::spawn(move || {
            if let Ok(mut s) = sup_clone.lock() {
                s.run();
            }
            stopped_clone.store(true, Ordering::SeqCst);
        });

        (
            Self {
                shutdown_requested,
                child_pid,
                stopped,
            },
            event_rx,
        )
    }

    pub fn shutdown(&self) {
        self.shutdown_requested.store(true, Ordering::SeqCst);

        // 20261031 实测（T-1 复测 roundT1-clean-workbench-a）：这一段曾耗时 **13.66s**
        // （p0：`sidecar shutdown begin` → `sidecar shutdown returned`），
        // 因为原实现每 500ms 重跑一次 taskkill+netstat 全表扫描，而 deadline 只在
        // 循环开头检查 → 一次迭代就能超时，整段被拖成十几秒。
        // 现在：立刻打一次（taskkill /T /F 是决定性的），随后只等监管线程确认停止，
        // 硬上限 2s；期间最多每 500ms 补打一次。
        let hard_deadline = Instant::now() + Duration::from_millis(800);
        let mut next_kill = Instant::now();
        loop {
            if self.stopped.load(Ordering::SeqCst) {
                break;
            }
            let now = Instant::now();
            if now >= hard_deadline {
                break;
            }
            if now >= next_kill {
                let pid = self.child_pid.load(Ordering::SeqCst);
                if pid != 0 {
                    terminate_process_tree_by_pid(pid);
                }
                next_kill = now + Duration::from_millis(500);
            }
            thread::sleep(Duration::from_millis(50));
        }

        // 到硬上限还没确认停止 → 只在子进程确实还活着时补一刀（避免重复的进程树枚举）。
        if !self.stopped.load(Ordering::SeqCst) {
            let pid = self.child_pid.load(Ordering::SeqCst);
            if pid != 0 && crate::pid_alive(pid) {
                terminate_process_tree_by_pid(pid);
            }
        }
    }
}

// ── 工具函数 ───────────────────────────────────────────────────────────

fn chrono_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
