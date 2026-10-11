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
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// ── 契约常量（⛔ DCD 禁改：端口 / 端点）──────────────────────────────
pub const HEALTH_HOST: &str = "127.0.0.1";
pub const HEALTH_PORT: u16 = 8760;
pub const HEALTH_PATH: &str = "/healthz";

// ── 时间预算（DCD 写死）───────────────────────────────────────────────
pub const STARTUP_HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
pub const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(100);
pub const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
pub const RESTART_DELAY: Duration = Duration::from_secs(2);
pub const MAX_RESTARTS: u8 = 5;
pub const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(5);

// ── 状态机 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarState {
    Spawning,
    Running,
    Crashed(String),
    Restarting(u8),
    GaveUp,
    Stopped,
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum SidecarEvent {
    StateChange { state: String, restarts: u8, pid: Option<u32> },
    Crash { reason: String, restarts: u8 },
    GaveUp { crashes: u8 },
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

// ── 监管主体 ───────────────────────────────────────────────────────────

pub struct SidecarSupervisor {
    state: SidecarState,
    child: Option<Child>,
    restarts: u8,
    project_root: PathBuf,
    event_tx: Sender<SidecarEvent>,
    shutdown_requested: bool,
    crash_log_path: Option<PathBuf>,
}

impl SidecarSupervisor {
    pub fn new(project_root: PathBuf, event_tx: Sender<SidecarEvent>) -> Self {
        let crash_log_path = std::env::var("STUDIO_LOG_DIR")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                dirs::config_dir().map(|d| d.join("deepseek-studio").join("logs"))
            });
        if let Some(ref p) = crash_log_path {
            let _ = std::fs::create_dir_all(p);
        }
        Self {
            state: SidecarState::Spawning,
            child: None,
            restarts: 0,
            project_root,
            event_tx,
            shutdown_requested: false,
            crash_log_path,
        }
    }

    fn spawn_child(&mut self) -> std::io::Result<Child> {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/c", "npx", "tsx", "src/api/main.ts"]);
            c
        } else {
            let mut c = Command::new("npx");
            c.args(["tsx", "src/api/main.ts"]);
            c
        };
        cmd.current_dir(&self.project_root)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
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

    fn set_state(&mut self, new_state: SidecarState) {
        let state_str = match &new_state {
            SidecarState::Spawning => "spawning",
            SidecarState::Running => "running",
            SidecarState::Crashed(_) => "crashed",
            SidecarState::Restarting(_) => "restarting",
            SidecarState::GaveUp => "gave-up",
            SidecarState::Stopped => "stopped",
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
                SidecarState::GaveUp | SidecarState::Stopped => {
                    return;
                }
            }
            if self.shutdown_requested && !matches!(self.state, SidecarState::Stopped) {
                self.do_shutdown();
                return;
            }
        }
    }

    fn do_spawn(&mut self) {
        let spawn_result = self.spawn_child();
        match spawn_result {
            Ok(child) => {
                self.child = Some(child);
                let start = Instant::now();
                // 等待 /healthz 就绪，最多 10s
                while start.elapsed() < STARTUP_HEALTH_TIMEOUT {
                    if probe_health() {
                        self.set_state(SidecarState::Running);
                        return;
                    }
                    thread::sleep(EXIT_POLL_INTERVAL);
                    if self.shutdown_requested {
                        self.do_shutdown();
                        return;
                    }
                }
                // 健康超时
                let _ = self.child.take().and_then(|mut c| {
                    let _ = c.kill();
                    c.wait().ok()
                });
                let reason = format!("health timeout after {:?}", STARTUP_HEALTH_TIMEOUT);
                self.set_state(SidecarState::Crashed(reason.clone()));
                self.write_crash_log(&reason);
                self.emit(SidecarEvent::Crash {
                    reason,
                    restarts: self.restarts,
                });
            }
            Err(e) => {
                let reason = format!("spawn failed: {}", e);
                self.set_state(SidecarState::Crashed(reason.clone()));
                self.write_crash_log(&reason);
                self.emit(SidecarEvent::Crash {
                    reason,
                    restarts: self.restarts,
                });
            }
        }
    }

    fn do_monitor(&mut self) {
        loop {
            thread::sleep(EXIT_POLL_INTERVAL);
            if self.shutdown_requested {
                self.do_shutdown();
                return;
            }
            if let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let reason = format!("process exited with status {:?}", status);
                        self.child = None;
                        if self.shutdown_requested {
                            self.set_state(SidecarState::Stopped);
                            return;
                        }
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
            if self.shutdown_requested {
                self.do_shutdown();
                return;
            }
        }
        self.set_state(SidecarState::Spawning);
    }

    fn do_shutdown(&mut self) {
        self.shutdown_requested = true;
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
                // Windows: 尝试 CTRL_BREAK，不行就直接 kill
                let _ = child.kill();
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
        }
        self.set_state(SidecarState::Stopped);
        eprintln!("[sidecar] stopped (graceful shutdown)");
    }

    pub fn request_shutdown(&mut self) {
        self.shutdown_requested = true;
    }
}

// ── 对外句柄 ───────────────────────────────────────────────────────────

pub struct SidecarHandle {
    cmd_tx: Sender<SupervisorCmd>,
    event_rx: Arc<Mutex<Option<Receiver<SidecarEvent>>>>,
}

#[derive(Debug)]
pub enum SupervisorCmd {
    Shutdown,
    Snapshot,
}

impl SidecarHandle {
    pub fn start(project_root: PathBuf) -> (Self, Receiver<SidecarEvent>) {
        let (event_tx, event_rx) = mpsc::channel::<SidecarEvent>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<SupervisorCmd>();

        let supervisor = Arc::new(Mutex::new(SidecarSupervisor::new(
            project_root,
            event_tx,
        )));

        // 监管线程
        let sup_clone = supervisor.clone();
        thread::spawn(move || {
            if let Ok(mut s) = sup_clone.lock() {
                s.run();
            }
        });

        // 命令线程
        let sup_clone2 = supervisor.clone();
        thread::spawn(move || {
            while let Ok(cmd) = cmd_rx.recv() {
                match cmd {
                    SupervisorCmd::Shutdown => {
                        if let Ok(mut s) = sup_clone2.lock() {
                            s.request_shutdown();
                        }
                    }
                    SupervisorCmd::Snapshot => {}
                }
            }
        });

        (
            Self {
                cmd_tx,
                event_rx: Arc::new(Mutex::new(None)),
            },
            event_rx,
        )
    }

    pub fn shutdown(&self) {
        let _ = self.cmd_tx.send(SupervisorCmd::Shutdown);
    }
}

// ── 工具函数 ───────────────────────────────────────────────────────────

fn chrono_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
