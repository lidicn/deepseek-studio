// 入口：v0.12 应用外壳。
//   - 主窗口加载真实 chat.deepseek.com（External URL），由 WebView 渲染真实站点。
//   - initialization_script 注入编译后的 src/desktop/entry.js。
//   - v0.12 Phase 1：受监管 sidecar 进程管理层。
//   - v0.12 Phase 3：系统托盘 + 窗口状态记忆。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod updater;

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// 主窗口关闭是「退出整个应用」的唯一入口：关闭流程只允许进入一次，
/// 避免多个窗口的 CloseRequested 并发触发多次 sidecar 关闭 / 窗口销毁。
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// 退出硬兜底预算：teardown 闭包排队成功后，若这么久还没把进程带走，watchdog 自己走。
///
/// 取值理由：正常路径（窗口数 1~3、WebView 回收 <1s）实测 1.9–3.7s 完成；
/// 5s 给出 1.3~2.6 倍余量，又不至于让用户觉得「点了关闭没反应」。
/// 用户点了关闭，进程必须在可预期的时间内消失——这是不可妥协的那一条。
const EXIT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// P0 定位打点（多窗退出挂死）：带毫秒时间戳与线程 id，用于区分三种挂起位置——
/// 后台收尾线程没起来、`sidecar.shutdown()` 阻塞、`run_on_main_thread` 未调度，
/// 以及逐个 `destroy()` 卡住。定位完成后整块删除。
fn p0_log(msg: impl AsRef<str>) {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!(
        "[p0 {}ms {:?}] {}",
        ms,
        std::thread::current().id(),
        msg.as_ref()
    );
}

/// 建窗「在建集合」：A 方案把建窗移到工作线程后，**并发调用会各建一个窗口**。
/// 20261031 实测（roundT1-hide1-bot2）：一次关闭前触发 3 个 `bot window build begin`
/// （线程 13/14/15）→ 建出 3 个窗、`maxVisible=3`、退出后残留 webview。
/// 这里做幂等闸：同一个 label 同时只允许一个在建，重复调用直接跳过。
static WINDOW_BUILD_INFLIGHT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// 登记「开始建窗」；已经在建则返回 false（调用方直接跳过）。
fn inflight_begin(label: &str) -> bool {
    let mut guard = WINDOW_BUILD_INFLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    set.insert(label.to_string())
}

fn inflight_end(label: &str) {
    let mut guard = WINDOW_BUILD_INFLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(label);
    }
}

/// debug 构建会附带一个控制台窗口；从资源管理器双击启动时它会一直挂在桌面上，
/// 和主窗口一起被当成“多出来的窗口”。仅当本进程独占该控制台时隐藏它，
/// 从终端 / IDE 启动时保持原样，避免把开发者自己的终端一起藏掉。
#[cfg(all(windows, debug_assertions))]
fn hide_orphan_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleWindow() -> isize;
        fn GetConsoleProcessList(list: *mut u32, count: u32) -> u32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    }
    unsafe {
        let hwnd = GetConsoleWindow();
        if hwnd == 0 {
            return;
        }
        let mut pids = [0u32; 4];
        let attached = GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32);
        if attached == 1 {
            ShowWindow(hwnd, 0); // SW_HIDE
        }
    }
}

#[cfg(not(all(windows, debug_assertions)))]
fn hide_orphan_console() {}

/// B（T-1 兜底）：退出前回收**本 app 归属**的 WebView2 进程。
///
/// 为什么需要：野窗口（Tauri 从未登记、但 HWND 与 WebView2 还活着）不在 Tauri 管理内，
/// 事件循环收尾时会一直等它的 WebView2 → `app.exit(0)` 只是"请求"退出（tauri app.rs:581），
/// 进程永远退不掉（20261031 实测：多窗关闭 30s 不退；强杀后仍残留 6 个 msedgewebview2）。
///
/// 匹配方式：**父进程 PID 匹配**——WebView2 的 browser 进程（每个窗口一个）由宿主进程
/// 直接拉起，其 `th32ParentProcessID` 就是本 app 的 PID；只杀父进程为「我」的
/// `msedgewebview2.exe`，不误伤同机其它 WebView2。
///
/// 演进（20261031）：
/// 1. 原实现用 PowerShell CIM 枚举命令行 → 实测单次 **9.9s**，且每次都闪控制台黑框；
/// 2. 改为 Toolhelp32Snapshot 枚举（毫秒级）：0.87–3.05s，取决于后续 `taskkill` spawn；
/// 3. 现改为 `OpenProcess + TerminateProcess` 直接结束（不再 spawn 子进程、不再有黑框），
///    并在结束后短轮询等 PID 真正消失——`TerminateProcess` 是异步的，
///    立刻 `process::exit(0)` 会让验证侧仍看到「残留」。
#[cfg(windows)]
fn terminate_app_webviews() -> usize {
    let me = std::process::id();
    let table = process_table();
    let roots: Vec<u32> = table
        .iter()
        .filter(|(_, ppid, name)| *ppid == me && name.starts_with("msedgewebview2"))
        .map(|(pid, _, _)| *pid)
        .collect();
    if roots.is_empty() {
        return 0;
    }
    // BFS 展开后代（browser 自己的 renderer / gpu 子进程），再倒序结束（叶子先死）。
    let mut order: Vec<u32> = Vec::new();
    let mut queue: Vec<u32> = roots;
    while let Some(p) = queue.pop() {
        if order.contains(&p) {
            continue;
        }
        order.push(p);
        for (pid, ppid, _) in &table {
            if *ppid == p && !order.contains(pid) {
                queue.push(*pid);
            }
        }
    }
    let mut killed = 0usize;
    for pid in order.iter().rev() {
        if terminate_pid(*pid) {
            killed += 1;
        }
    }
    // 不做「等 PID 消失」的轮询：WebView2 的 browser 进程被杀后，只要宿主还活着，
    // 它的守护逻辑会**立刻重启**一个 browser 进程（20261031 实测：R71 杀完再等 300ms，
    // 反而留下 1 个；R73 杀 14 个后等 300ms，残留 5 个）。这里杀完立即返回，
    // 由紧随其后的 `std::process::exit(0)` 一并终结，宿主先死则不会被重启。
    killed
}

#[cfg(not(windows))]
fn terminate_app_webviews() -> usize {
    0
}

/// 读一次系统进程表：`(pid, ppid, 小写 exe 名)`。
#[cfg(windows)]
fn process_table() -> Vec<(u32, u32, String)> {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESSENTRY32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const INVALID_HANDLE_VALUE: isize = -1;

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut rows = Vec::new();
    unsafe {
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            cntUsage: 0,
            th32ProcessID: 0,
            th32DefaultHeapID: 0,
            th32ModuleID: 0,
            cntThreads: 0,
            th32ParentProcessID: 0,
            pcPriClassBase: 0,
            dwFlags: 0,
            szExeFile: [0u16; 260],
        };
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name = String::from_utf16_lossy(&entry.szExeFile).to_ascii_lowercase();
                rows.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    rows
}

/// 进程是否还活着（`OpenProcess` 失败即视为已消失）。
#[cfg(windows)]
pub(crate) fn pid_alive(pid: u32) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle == 0 {
        return false;
    }
    unsafe {
        CloseHandle(handle);
    }
    true
}

#[cfg(not(windows))]
pub(crate) fn pid_alive(_pid: u32) -> bool {
    false
}

/// 结束单个进程；成功返回 true。`TerminateProcess` 是异步的（返回不代表已消失）。
#[cfg(windows)]
fn terminate_pid(pid: u32) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn TerminateProcess(handle: isize, code: u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const PROCESS_TERMINATE: u32 = 0x0001;
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if handle == 0 {
        return false;
    }
    let ok = unsafe { TerminateProcess(handle, 1) } != 0;
    unsafe {
        CloseHandle(handle);
    }
    ok
}

#[cfg(not(windows))]
fn terminate_pid(_pid: u32) -> bool {
    false
}

/// 结束「pid 及其全部后代」的进程树（后代先死，父进程后死），返回结束个数。
/// 供 sidecar 关闭复用：替代 `taskkill /T /F` 子进程（不再 spawn、不再闪黑框）。
#[cfg(windows)]
pub(crate) fn terminate_tree(root: u32) -> usize {
    let table = process_table();
    let mut order: Vec<u32> = Vec::new();
    let mut queue: Vec<u32> = vec![root];
    while let Some(p) = queue.pop() {
        if order.contains(&p) {
            continue;
        }
        order.push(p);
        for (pid, ppid, _) in &table {
            if *ppid == p && !order.contains(pid) {
                queue.push(*pid);
            }
        }
    }
    let mut killed = 0usize;
    for pid in order.iter().rev() {
        if terminate_pid(*pid) {
            killed += 1;
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
    while std::time::Instant::now() < deadline && order.iter().any(|p| pid_alive(*p)) {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    killed
}

#[cfg(not(windows))]
pub(crate) fn terminate_tree(_root: u32) -> usize {
    0
}

/// 运行时读取注入脚本（而非 include_str! 编译时嵌入）。
/// 搜索顺序：当前工作目录 → 相对于 exe 目录（向上找项目根）→ exe 同级。
fn load_init_script(resource_dir: Option<&std::path::Path>) -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    // 打包版（TD-04 补缺）：注入脚本随包分发在 `<resource_dir>/inject/entry.js`。
    //
    // **必须排在候选最前**：否则安装版若 CWD 恰好在仓库根，会先命中相对路径
    // `src-tauri/inject/entry.js` —— 借到的是**开发树的产物**，
    // 于是「安装版自带注入」这条根本没被证明（20261103 实测：安装版 CWD=仓库根时正是如此）。
    // 排最前之后：安装版永远用包内那份，CWD 在哪都借不到开发树。
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("inject/entry.js"));
    }
    candidates.push(std::path::PathBuf::from("inject/entry.js"));
    candidates.push(std::path::PathBuf::from("src-tauri/inject/entry.js"));

    if let Some(root) = exe_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
    {
        candidates.push(root.join("inject/entry.js"));
        candidates.push(root.join("src-tauri/inject/entry.js"));
    }
    candidates.push(exe_dir.join("inject/entry.js"));

    for candidate in &candidates {
        if let Ok(s) = std::fs::read_to_string(candidate) {
            eprintln!("[studio] inject loaded from: {:?}", candidate);
            return s;
        }
    }
    eprintln!("[studio] WARN: entry.js not found, running without injection");
    String::new()
}

const CHAT_URL: &str = "https://chat.deepseek.com";

// ── 窗口状态记忆（v0.12 Phase 3）──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WindowState {
    width: Option<f64>,
    height: Option<f64>,
    x: Option<i32>,
    y: Option<i32>,
    maximized: Option<bool>,
}

fn window_state_path() -> std::path::PathBuf {
    window_state_path_with(std::env::var("STUDIO_CONFIG_DIR").ok().as_deref(), dirs::config_dir().as_deref())
}

/// 窗口状态落点（**可注入**，两形态各一条单测）。
///
/// - **装版**：Rust 在批 N+1 段 2 注入 `STUDIO_CONFIG_DIR = <data_dir>/config` →
///   窗口状态与 Node 侧配置同目录（同一份数据根，用户文件夹里只有一处 deepseek-studio）。
///   老用户的 `window-state.json` 由段 3 首启迁移搬过去（`config-migration.ts`），
///   源文件保留不删，故升级后窗口几何不丢。
/// - **dev**：无人注入 → `config_dir_env = None` → 回落 `dirs::config_dir()/deepseek-studio`，
///   **行为逐字节不变**（这是硬要求：dev 形态必须保持旧落点）。
fn window_state_path_with(
    config_dir_env: Option<&str>,
    config_dir_fallback: Option<&std::path::Path>,
) -> std::path::PathBuf {
    if let Some(dir) = config_dir_env.map(str::trim).filter(|s| !s.is_empty()) {
        return std::path::PathBuf::from(dir).join("window-state.json");
    }
    config_dir_fallback
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("deepseek-studio")
        .join("window-state.json")
}

fn load_window_state() -> WindowState {
    let path = window_state_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        if let Ok(state) = serde_json::from_str::<WindowState>(&s) {
            return state;
        }
    }
    WindowState::default()
}

fn save_window_state(state: &WindowState) {
    let path = window_state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        if let Err(e) = std::fs::write(&path, json) {
            eprintln!("[studio] failed to save window state: {:?}", e);
        }
    }
}

// ── v0.24：多 bot 窗口 + profile 隔离 ────────────────────────────────────
// 预配置驱动（不在运行时创建窗口）：~/.config/deepseek-studio/bot-windows.json
//   [ { "botId": "bot-S1", "visible": false, "dataDir": "profiles/S1" } ]
// 主窗口（label="main"）总是可见并注入 main 脚本；每个 bot 窗口各自注入
// 带 __studioBotId 的脚本，并用独立 data_directory 隔离登录态（Cookie/localStorage/IndexedDB）。
// 缺文件 / 缺字段 / 解析失败一律跳过该条目，绝不阻塞主窗口启动。

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BotWindowConfig {
    #[serde(default = "default_bot_id")]
    bot_id: String,
    #[serde(default = "default_visible")]
    visible: bool,
    #[serde(default)]
    data_dir: Option<String>,
}

fn default_bot_id() -> String {
    String::new()
}

fn default_visible() -> bool {
    false
}

#[derive(Debug, Clone, Deserialize, Default)]
struct BotWindowsConfig {
    #[serde(default)]
    bots: Vec<BotWindowConfig>,
}

// ── 聊天室配置（v0.28 PoC 聊天室 UI）──────────────────────────────────
// 读 ~/.config/deepseek-studio/config.json（Node sidecar 的 loadConfig 同路径），
// 取 token + chatRooms[0]，注入 window.__studioChatConfig 供主窗口聊天室 UI 连 /agent-ws。
// 注意：config.json 在 home_dir/.config 下（Unix 风格），与 bot-windows.json 在
// config_dir/AppData\Roaming 下**不是同一目录**——这里用 home_dir。

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StudioConfig {
    #[serde(default)]
    token: String,
    /// TD-02：HMAC 签名密钥（与 host(ts) 的 secret 同一份），用于签 bootstrap grant。
    #[serde(default)]
    secret: String,
    #[serde(default)]
    chat_rooms: Vec<ChatRoomEntry>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    host: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ChatRoomEntry {
    room_id: String,
    room_name: String,
    #[serde(default)]
    member_personas: Vec<String>,
}

/// 读 config.json → 构造注入脚本片段 `window.__studioChatConfig = {...};`。
/// 缺文件/无 token/无 chatRooms → 返回空串（聊天室 UI 不挂载，向后兼容）。
fn load_studio_chat_config_script() -> String {
    let cfg_path = config_dir().join("config.json");
    let s = match std::fs::read_to_string(&cfg_path) {
        Ok(s) => s,
        Err(e) => {
            // 与 grant 同一个失败模式（P0 卡 (C) 覆盖的第 9 处族）：读不到就回空串 =
            // 聊天室 UI 静默不挂载。至少留一行，别让「少了一块功能」无迹可查。
            grant_log(&format!(
                "[studio] chat-config: no-config-file code={:?} path={}",
                e.kind(),
                cfg_path.display()
            ));
            return String::new();
        }
    };
    let cfg: StudioConfig = match serde_json::from_str(&s) {
        Ok(c) => c,
        Err(e) => {
            grant_log(&format!("[studio] chat-config: parse-failed err={} path={}", e, cfg_path.display()));
            return String::new();
        }
    };
    if cfg.token.is_empty() || cfg.chat_rooms.is_empty() {
        grant_log(&format!(
            "[studio] chat-config: disabled token_empty={} rooms={} path={}",
            cfg.token.is_empty(),
            cfg.chat_rooms.len(),
            cfg_path.display()
        ));
        return String::new();
    }
    let room = &cfg.chat_rooms[0];
    if room.room_id.is_empty() {
        return String::new();
    }
    let host = cfg.host.as_deref().unwrap_or("127.0.0.1");
    let port = cfg.port.unwrap_or(8760);
    let ws_url = format!("ws://{}:{}/agent-ws", host, port);
    let payload = serde_json::json!({
        "wsUrl": ws_url,
        "token": cfg.token,
        "roomId": room.room_id,
        "roomName": room.room_name,
        "members": room.member_personas,
    });
    format!("window.__studioChatConfig = {};\n", payload)
}

/// 进程内的 sidecar 日志落点（P0 卡 (C)，2026-11-06）。
///
/// 为什么需要它：装版是 GUI 进程、**无控制台** → 本文件里所有 `eprintln!` 在装版下
/// 直接丢弃（`sidecar.rs` 的 stderr 只在 `try_clone` 成功时才接进日志文件）。
/// 而「grant 为什么没签出来」正是 P0 现场最需要的一条信息，必须**直写文件**。
///
/// 设置时机：`main` 里计算 `host_entry` 之后、建窗之前（与实际打开的那份日志同一路径）。
/// 未设置时（单测 / 无 sidecar 场景）自动降级为 `eprintln!`，不让日志通路成为崩溃点。
static SIDECAR_LOG_PATH: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

/// 设置/清除 sidecar 日志落点。
fn set_sidecar_log_path(p: Option<std::path::PathBuf>) {
    if let Ok(mut g) = SIDECAR_LOG_PATH.lock() {
        *g = p;
    }
}

/// 写一行到 sidecar 日志文件（**直写 + flush**，不依赖 stdout/stderr 重定向）。
///
/// **共用哪份文件**（裁定三十九 2026-11-06）：优先用 `sidecar::current_log_file()`
/// —— 即宿主自己的 `sidecar-<ms>.log`，做到「取证单点」。只有在 sidecar 尚未 spawn
/// （拿不到路径）时，才退回 `SIDECAR_LOG_PATH`（`main` 里算的兜底路径）。
///
/// ⚠️ **只能用 append(true) 打开**：判别实验（Core 实跑，4000 行并发）证明
/// 两个 O_APPEND 写方并发零丢失；而「按偏移定位 / 带缓冲」的写方会**整段覆盖**
/// 并发行（实测丢 236 / 1143 行）。谁改成先算长度再写，这条安全就没了。
/// 失败时退回 `eprintln!` —— 装版下会丢，但不能因为写日志失败而 panic。
fn grant_log(line: &str) {
    let path = sidecar::current_log_file().or_else(|| {
        SIDECAR_LOG_PATH.lock().ok().and_then(|g| g.clone())
    });
    let wrote = match path {
        Some(p) => std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "{}", line)?;
                f.flush()
            })
            .is_ok(),
        None => false,
    };
    if !wrote {
        eprintln!("{}", line);
    }
}

/// 解析配置目录（P0 卡 (B)：**全仓唯一入口**，不许再出现 `.join(".config")` 字面量）。
///
/// - 装版（`packaged`）且拿到了 `app_data_dir` → `<app_data_dir>/config`
///   —— 与批 N+1 注入给宿主的 `STUDIO_CONFIG_DIR` **同一个落点**（`main.rs` 的
///   `resolve_host_entry_with_data_dir` 就是这么推的）。两者必须同源，否则 Rust 读
///   旧路径、宿主写新路径，装版永远签不出 grant（推断风险面，待 v0.14.8 真机坐实）。
/// - dev / 拿不到 `app_data_dir` → `~/.config/deepseek-studio`（历史行为，逐字节不变）。
fn resolve_config_dir(packaged: bool, app_data_dir: Option<&std::path::Path>) -> std::path::PathBuf {
    if packaged {
        if let Some(d) = app_data_dir {
            return d.join("config");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".config")
        .join("deepseek-studio")
}

/// 生产调用点：按构建类型取 `packaged`，`app_data_dir` 由调用方给。
fn config_dir() -> std::path::PathBuf {
    // `app_data_dir` 只在 `AppHandle` 上拿得到；窗口/命令上下文里统一走
    // `app.path().app_data_dir()` 后再调 `resolve_config_dir`，这里给出兜底版本。
    resolve_config_dir(!cfg!(debug_assertions), None)
}

/// P0 卡 (A)：签发速率限制与 jti 记账（**每个窗口**一份，随窗口销毁回收）。
///
/// 为什么必须限流：本命令把「读一次静态 grant」变成「可无限现签」，虽然是 60s /
/// 一次性 / 绑 aud / 仅 ws-connect（不削弱 TD-02），但**可无限续签是实质变化**，
/// 必须给上界。口径（PM 裁定三十三 2）：
///   - 同一窗口两次签发间隔 ≥ 1s；
///   - 单窗口生命周期上限 200 张；
///   - 超限返回 `rate-limited` 并写一行 `level=warn` 可 grep 日志。
///
/// key 用 **`window.label()`** 而不是 `aud`：`aud` 是字符串，`bot:<id>` 在多窗场景会撞
/// （多窗口虽已封盘，key 选错是埋雷，而现在改是零成本）。
#[derive(Debug, Default)]
struct GrantRateEntry {
    last_ms: u64,
    count: u32,
}

static GRANT_RATE: Mutex<Option<std::collections::HashMap<String, GrantRateEntry>>> = Mutex::new(None);

/// 限流常量（单测直接引用，避免测试与实现各写一份魔数）。
const GRANT_MIN_INTERVAL_MS: u64 = 1_000;
const GRANT_MAX_PER_WINDOW: u32 = 200;

/// 限流检查 + 记账（**纯函数**，便于单测；不碰全局）。
///
/// 返回 `Ok(())` 表示放行，`Err("rate-limited")` 表示拒签。
fn grant_rate_check(
    map: &mut std::collections::HashMap<String, GrantRateEntry>,
    label: &str,
    now_ms: u64,
) -> Result<(), &'static str> {
    let e = map.entry(label.to_string()).or_default();
    // 首次：last_ms == 0 视为没签发过
    if e.last_ms != 0 && now_ms.saturating_sub(e.last_ms) < GRANT_MIN_INTERVAL_MS {
        return Err("rate-limited");
    }
    if e.count >= GRANT_MAX_PER_WINDOW {
        return Err("rate-limited");
    }
    e.last_ms = now_ms;
    e.count += 1;
    Ok(())
}

/// 窗口销毁时清掉它的计数（**没有回收的「上界」= 看着有保护、实际单调增长**）。
fn grant_rate_forget(map: &mut std::collections::HashMap<String, GrantRateEntry>, label: &str) -> bool {
    map.remove(label).is_some()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// (A) 的返回形状：**可辨识联合**（裁定三十三 一）。
///
/// 不能用「`ok: bool` + 一堆可选字段」—— 那种形状让 `ok:true` 但字段缺失成为可能，
/// 正是 `fillPathRows` 那个坑的同族。`#[serde(untagged)]` + 两个结构体让序列化后
/// 恰好是 `{ok:true,grant,expMs}` 或 `{ok:false,error}`，没有多余字段。
#[derive(serde::Serialize)]
struct GrantReplyOk {
    ok: bool,
    grant: String,
    #[serde(rename = "expMs")]
    exp_ms: u64,
}

#[derive(serde::Serialize)]
struct GrantReplyErr {
    ok: bool,
    error: &'static str,
}

#[derive(serde::Serialize)]
#[serde(untagged)]
enum GrantReply {
    Ok(GrantReplyOk),
    Err(GrantReplyErr),
}

/// P0 卡 (A)：页面**每次连接/重连前**调用，现签一张 60s/一次性/绑 aud 的券。
///
/// 一次解决三件事：① 首启竞态（建窗时 config 可能还没写出来）；② 重连复用死券；
/// ③ TTL 过短。
#[tauri::command]
fn studio_request_grant(window: tauri::WebviewWindow, aud: String) -> GrantReply {
    let trimmed = aud.trim();
    let bad_aud = trimmed.is_empty()
        || (trimmed != "main" && !trimmed.starts_with("bot:"));
    if bad_aud {
        grant_log(&format!("[studio] grant: bad-aud aud={}", trimmed));
        return GrantReply::Err(GrantReplyErr { ok: false, error: "bad-aud" });
    }

    let label = window.label().to_string();
    let allowed = {
        let mut guard = GRANT_RATE.lock().ok();
        match guard.as_mut() {
            Some(slot) => {
                let map = slot.get_or_insert_with(std::collections::HashMap::new);
                grant_rate_check(map, &label, now_ms())
            }
            None => Err("rate-limited"),
        }
    };
    if allowed.is_err() {
        grant_log(&format!(
            "[studio] level=warn grant: rate-limited label={} aud={}",
            label, trimmed
        ));
        return GrantReply::Err(GrantReplyErr { ok: false, error: "rate-limited" });
    }

    let cfg_path = config_dir().join("config.json");
    let s = match std::fs::read_to_string(&cfg_path) {
        Ok(s) => s,
        Err(e) => {
            grant_log(&format!(
                "[studio] grant: no-config-file aud={} code={:?} path={}",
                trimmed,
                e.kind(),
                cfg_path.display()
            ));
            return GrantReply::Err(GrantReplyErr { ok: false, error: "no-config" });
        }
    };
    let cfg: StudioConfig = match serde_json::from_str(&s) {
        Ok(c) => c,
        Err(e) => {
            grant_log(&format!(
                "[studio] grant: parse-failed aud={} err={} path={}",
                trimmed,
                e,
                cfg_path.display()
            ));
            // 配置损坏对页面来说等同「没有可用配置」
            return GrantReply::Err(GrantReplyErr { ok: false, error: "no-config" });
        }
    };
    if cfg.secret.is_empty() {
        grant_log(&format!("[studio] grant: empty-secret aud={} path={}", trimmed, cfg_path.display()));
        return GrantReply::Err(GrantReplyErr { ok: false, error: "no-secret" });
    }
    match issue_bootstrap_grant_rs(&cfg.secret, trimmed, 60_000) {
        Some(grant) => {
            grant_log(&format!("[studio] grant: ok aud={} expMs=60000 label={}", trimmed, label));
            GrantReply::Ok(GrantReplyOk { ok: true, grant, exp_ms: 60_000 })
        }
        None => {
            grant_log(&format!("[studio] grant: sign-failed aud={} path={}", trimmed, cfg_path.display()));
            GrantReply::Err(GrantReplyErr { ok: false, error: "sign-failed" })
        }
    }
}

/// P0 卡 (A)：注入**取券闭包** `window.__studioRequestGrant(aud)`，取代建窗时烤死的静态券。
///
/// 安全性（裁定三十三 修正 1）：远端页面**拿不到裸 `invoke`** —— 闭包在 init script 里
/// 捕获 `__TAURI_INTERNALS__`，页面只能调这一个函数，且 Rust 侧仍逐次校验 aud 并限流。
fn grant_request_closure_script() -> String {
    // 与既有 `__studioOpenWorkbench` 同一套路（`src/desktop/entry.ts` 用 `__TAURI_INTERNALS__`）。
    "(function(){\n\
      try {\n\
        var internals = window.__TAURI_INTERNALS__;\n\
        if (!internals || typeof internals.invoke !== 'function') { return; }\n\
        window.__studioRequestGrant = function (aud) {\n\
          return internals.invoke('studio_request_grant', { aud: String(aud || '') });\n\
        };\n\
      } catch (e) { /* 取券闭包注入失败 → 页面按 fail-visible 提示，不静默 */ }\n\
    })();\n"
        .to_string()
}

/// TD-02：把**短期一次性 bootstrap grant** 注入 `window.__studioGrant`（不再注入 config.token）。
///
/// 背景：原实现注入 `window.__studioHostToken = <config.token>`，外部页面（chat.deepseek.com）
/// 里任意脚本读得到 → 等于拿到宿主全权凭据（WS 连工具通道 + Bearer 打 /v1/*）。
/// 现在改为注入 grant：60s、一次性、仅 ws-connect 权、绑 audience。危害降级为
/// 「一张 60s 内只能用一次的连接券」，不再是永久全权钥匙。
///
/// 签发格式与 host(ts) `host-token.ts` 逐字节一致：
///   payload = base64url(JSON(claims))；sig = base64url(HMAC-SHA256(secret, payload))；
///   grant   = payload + "." + sig
/// claims = { iss, jti, aud, scope:"ws-connect", iat, exp }（exp/iat 为毫秒 epoch）。
///
/// audience：bot 窗口传 "bot:<id>"，主窗传 "main"——页面连接时须带 `?aud=<同值>` 才过得验证。
    // （保留原文档注释）
fn load_host_grant_script_with(cfg_path: &std::path::Path, audience: &str) -> String {
    let s = match std::fs::read_to_string(cfg_path) {
        Ok(s) => s,
        Err(e) => {
            // 终局 1/4：文件不存在 / 读不了。**首启竞态的第一现场** ——
            // 建窗时宿主可能还没写出 config.json（2026-11-06 实测：建窗 12:19:14，
            // config.json 12:19:15 才创建），此分支就是「grant 恒空」的直接原因。
            grant_log(&format!(
                "[studio] grant: no-config-file aud={} code={:?} path={}",
                audience,
                e.kind(),
                cfg_path.display()
            ));
            return String::new();
        }
    };
    let cfg: StudioConfig = match serde_json::from_str(&s) {
        Ok(c) => c,
        Err(e) => {
            grant_log(&format!(
                "[studio] grant: parse-failed aud={} err={} path={}",
                audience,
                e,
                cfg_path.display()
            ));
            return String::new();
        }
    };
    // 旧版 config 可能无 secret（只补了 token）→ 无 secret 就无法签 grant，
    // 此时退回空串（页面裸连；生产由 host 侧 fail-closed，dev 允许 loopback）。
    if cfg.secret.is_empty() {
        grant_log(&format!(
            "[studio] grant: empty-secret aud={} path={}",
            audience,
            cfg_path.display()
        ));
        return String::new();
    }
    let grant = match issue_bootstrap_grant_rs(&cfg.secret, audience, 60_000) {
        Some(g) => g,
        None => {
            grant_log(&format!(
                "[studio] grant: sign-failed aud={} path={}",
                audience,
                cfg_path.display()
            ));
            return String::new();
        }
    };
    grant_log(&format!(
        "[studio] grant: ok aud={} expMs=60000 path={}",
        audience,
        cfg_path.display()
    ));
    format!(
        "window.__studioGrant = {};\n",
        serde_json::to_string(&grant).unwrap()
    )
}

fn load_host_grant_script(audience: &str) -> String {
    load_host_grant_script_with(&config_dir().join("config.json"), audience)
}

/// TD-02：Rust 侧签发 bootstrap grant（与 host-token.ts 的 signRaw 同算法）。
/// 返回 None 表示 HMAC/编码失败（极少）。纯函数便于单测。
fn issue_bootstrap_grant_rs(secret: &str, audience: &str, ttl_ms: u64) -> Option<String> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    // jti：16 字节随机，base64url（不填充）。用系统时间 + 进程 id + 计数器做熵源足够（一次性由 host 记 jti）。
    let jti = {
        let mut bytes = [0u8; 16];
        let seed = format!(
            "{}:{}:{}:{}",
            now,
            std::process::id(),
            audience,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        );
        let h = Sha256::digest(seed.as_bytes());
        bytes.copy_from_slice(&h[..16]);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    };
    let claims = format!(
        "{{\"iss\":\"deepseek-studio-host\",\"jti\":\"{}\",\"aud\":\"{}\",\"scope\":\"ws-connect\",\"iat\":{},\"exp\":{}}}",
        jti,
        audience.replace('\\', "\\\\").replace('"', "\\\""),
        now,
        now + ttl_ms
    );
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.as_bytes());
    let sig_raw = hmac_sha256(secret.as_bytes(), payload.as_bytes());
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig_raw);
    Some(format!("{}.{}", payload, sig))
}

/// 标准 HMAC-SHA256（RFC 2104），密钥/消息均为字节。用 sha2 实现，不引入 hmac crate。
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let d = Sha256::digest(key);
        k[..32].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    let out = outer.finalize();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&out);
    buf
}

// W2（20261023）：启动不再读这份配置建窗，读它的入口只剩下面这条路径 +
// 供将来「预置 profile 映射」用。保留而不是删掉，是因为按需建窗仍可能想知道
// 某个 botId 的预置 dataDir；加 allow(dead_code) 明确「现在确实没人调」。
#[allow(dead_code)]
fn bot_windows_path() -> std::path::PathBuf {
    // 两个配置刻意分处不同目录，是既定设计，别「对齐」：
    //   config.json      → home/.config/deepseek-studio/（Node 侧 main.ts 读同一路径）
    //   bot-windows.json → dirs::config_dir()/deepseek-studio/（Windows = %APPDATA%）
    // 20261017 用户明确要求把这里清成 {"bots":[]}，启动只留主窗口；bot 窗口改为
    // 按需（主 bot 用聊天室时）再拉起。home/.config 下那份是更早的残留（含
    // frontend/backend-expert），照它开窗会违背该决定 —— 故此处不得回退到它。
    // (B) 路径同源：bot-windows.json 跟统一解析走（封盘路线，不补装版兜底）
    config_dir().join("bot-windows.json")
}

#[allow(dead_code)]
fn load_bot_windows_config() -> BotWindowsConfig {
    let path = bot_windows_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        // P1-1：去 BOM。PowerShell 5.1 `Set-Content -Encoding UTF8` 写出的文件
        // 带 U+FEFF，read_to_string 会把它保留成字符，serde_json 的 from_str
        // 不接受前导 BOM → 恒解析失败（表现为 WARN + using empty）。
        let cleaned = s.trim_start_matches('\u{feff}');
        if let Ok(cfg) = serde_json::from_str::<BotWindowsConfig>(cleaned) {
            eprintln!("[studio] bot windows config: {} entries", cfg.bots.len());
            return cfg;
        }
        eprintln!(
            "[studio] WARN: bot-windows.json parse failed ({}), using empty",
            path.display()
        );
    }
    BotWindowsConfig::default()
}

/// 带 botId 的注入脚本：在原脚本最前面声明 window.__studioBotId，
/// 供 entry.ts 的 createHostClient 读取（缺省 = 'main'）。
fn inject_with_bot_id(base_script: &str, bot_id: &str) -> String {
    let declare = format!(
        "window.__studioBotId = {};\n",
        serde_json::to_string(bot_id).unwrap()
    );
    declare + base_script
}

/// 把配置的 dataDir 解析为可用的 profile 目录。
///  - 绝对路径（Windows `C:\...` 或 Unix `/...`）→ 原样使用
///  - `~/...` → 展开到系统配置目录
///  - 其它相对路径 → 拼到 ~/.config/deepseek-studio/ 下
/// 空串 / 解析不出配置目录 → None（调用方降级为共享 profile）。
fn resolve_data_dir(raw: &str) -> Option<std::path::PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let base = dirs::config_dir()?;
    let path = if trimmed.starts_with('/') || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':')
    {
        std::path::PathBuf::from(trimmed)
    } else if trimmed == "~" || trimmed.starts_with("~/") {
        base.join(trimmed.trim_start_matches("~/"))
    } else {
        // (B) 相对路径基址跟统一解析走
        config_dir().join(trimmed)
    };
    Some(path)
}

/// bot 窗口创建计划：把「该不该建、用哪个 profile」从建窗 IO 里分离出来，便于单测。
///
/// 之所以要这一层：v0.31 前 bot 窗口循环里 dataDir 缺失/非法会**静默回退到主 profile**
/// （只打一句 "cookies WILL cross" 警告然后照建），等于把主账号塞进第二个窗口；
/// 且两条目解析到同一 profile 时也不报错。二者都直接违反设计稿 §6 铁律
/// 「1 槽位 : 1 账号 : 1 窗口」——同账号多窗口正是 DeepSeek 封号判据。
#[derive(Debug, PartialEq, Eq)]
enum BotWindowPlan {
    Create {
        label: String,
        bot_id: String,
        visible: bool,
        data_dir: std::path::PathBuf,
    },
    Skip {
        bot_id: String,
        reason: String,
    },
}

/// Windows 路径大小写不敏感 → 归一化后比较，避免同一 profile 被两条目共用却判为不同。
fn normalize_for_compare(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// 决定每个配置条目该建窗口还是跳过。
///
/// 铁律落地：
///  - dataDir 缺失/非法 → **不再回退主 profile**，改为按 botId 派生
///    `profiles/<botId>` 独立 profile（窗口照建，但登录态隔离）；
///  - 两个条目解析到**同一 profile**（含与主窗口 profile / 与派生目录撞车）→
///    后者跳过（同账号双窗口 = 必封，fail-closed 而不是静默共用）。
///
/// `reserved` 是已占用的 profile 目录（调用方传主窗口自己的 profile）。
fn plan_bot_windows(
    entries: &[BotWindowConfig],
    reserved: &[std::path::PathBuf],
) -> Vec<BotWindowPlan> {
    let mut used: Vec<String> = reserved.iter().map(|p| normalize_for_compare(p)).collect();
    let mut labels: Vec<String> = Vec::new();
    let mut plans = Vec::with_capacity(entries.len());

    for entry in entries {
        let bot_id = entry.bot_id.trim().to_string();
        if bot_id.is_empty() {
            plans.push(BotWindowPlan::Skip {
                bot_id,
                reason: "empty botId".to_string(),
            });
            continue;
        }
        let label = sanitize_window_label(&bot_id);
        if labels.iter().any(|l| l == &label) {
            plans.push(BotWindowPlan::Skip {
                bot_id,
                reason: format!("duplicate label {:?}", label),
            });
            continue;
        }
        // 显式 dataDir 优先；缺失/非法 → 派生 profiles/<botId>，绝不共享主 profile。
        let data_dir = match entry.data_dir.as_deref().and_then(resolve_data_dir) {
            Some(d) => d,
            None => match Some(config_dir().join("profiles").join(&bot_id))
            {
                Some(d) => d,
                None => {
                    plans.push(BotWindowPlan::Skip {
                        bot_id,
                        reason: "no dataDir and config_dir unavailable".to_string(),
                    });
                    continue;
                }
            },
        };
        let key = normalize_for_compare(&data_dir);
        if used.iter().any(|u| u == &key) {
            plans.push(BotWindowPlan::Skip {
                bot_id,
                reason: format!(
                    "profile {} already used by another window (1 slot : 1 account : 1 window)",
                    data_dir.display()
                ),
            });
            continue;
        }
        used.push(key);
        labels.push(label.clone());
        plans.push(BotWindowPlan::Create {
            label,
            bot_id,
            visible: entry.visible,
            data_dir,
        });
    }
    plans
}

/// 窗口 label 只做字母数字 + 短横/下划线/点，避免非法字符导致 Tauri 拒绝创建。
/// 截断到 32 字符并保证非空（退化为 "bot"）。
fn sanitize_window_label(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if out.len() >= 32 {
            break;
        }
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        }
    }
    if out.is_empty() {
        "bot".to_string()
    } else {
        out
    }
}

/// W1：工作台窗口 URL（`http://host:port/agent`），与 sidecar 读同一份 config.json 的
/// host/port；缺文件/解析失败回落 127.0.0.1:8760。不 panic。
///
/// 与 `mcp_settings_url()` 同源（都用 `studio_host_port()`）：两处各读一遍
/// `config.json` 就会在「用户改了端口」时漂移，故收敛到同一个读取函数。
fn studio_host_port() -> (String, u16) {
    // (B) 路径同源：与 grant / 宿主读**同一个** config.json（装版 = <app_data_dir>/config）
    std::fs::read_to_string(config_dir().join("config.json"))
        .ok()
        .as_deref()
        .and_then(|s| serde_json::from_str::<StudioConfig>(s).ok())
        .map(|c| {
            (
                c.host.unwrap_or_else(|| "127.0.0.1".to_string()),
                c.port.unwrap_or(8760),
            )
        })
        .unwrap_or_else(|| ("127.0.0.1".to_string(), 8760))
}

fn workbench_url() -> String {
    let (host, port) = studio_host_port();
    format!("http://{}:{}/agent", host, port)
}

/// W1：打开 Workbench 窗口。已存在则 show + unminimize + set_focus，不重复建窗；
/// 否则按 workbench_url() 新建 External 窗口。URL 解析/建窗失败返回 Err，不 unwrap/expect。
#[tauri::command]
fn open_workbench(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("workbench") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }
    let url = Url::parse(&workbench_url()).map_err(|e| format!("invalid workbench url: {}", e))?;
    // A（T-1 治本）：建窗必须离开 IPC 回调。
    //
    // 根因（20261031 实测 + tauri 源码）：wry runtime 建 webview 是
    // 「send_user_message 投递 + rx.recv() 阻塞等事件循环建窗」（tauri-runtime-wry-2.12.1
    // lib.rs:365-405）；而 `send_user_message` 在**主线程上会内联执行**（同文件 lib.rs:263-280）。
    // IPC 回调本身就跑在主线程（p0 日志 ThreadId(1)）→ WebView2 控制器创建被嵌在 WebView2 的
    // IPC 消息派发里 → UI 线程没法泵消息 → 死锁：HWND 建出来、webview 停在 about:blank、
    // Tauri 永远不登记它（teardown 只看得到 ["main"]），退出时它的 WebView2 又拖住收尾。
    //
    // 改法：建窗放到工作线程执行——主线程立即返回，事件循环空闲，能正常处理投递过来的建窗消息。
    // 前端 `__studioOpenWorkbench` 本来就是 fire-and-forget，不依赖同步返回。
    if !inflight_begin("workbench") {
        p0_log("workbench build skipped (already inflight)");
        return Ok(());
    }
    std::thread::spawn(move || {
        p0_log("workbench build begin (worker)");
        let built = WebviewWindowBuilder::new(&app, "workbench", WebviewUrl::External(url))
            .title("DeepSeek++ Studio · 工作台")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 720.0)
            .build();
        // P0 定位：工作台窗到底有没有被 Tauri 登记（上一轮 teardown 只看到 ["main"]，而 OS 层窗口仍在）。
        p0_log(format!(
            "workbench build ok={} tracked={:?}",
            built.is_ok(),
            app.webview_windows().keys().collect::<Vec<_>>()
        ));
        if let Err(e) = built {
            eprintln!("[studio] failed to create workbench window: {}", e);
        }
        inflight_end("workbench");
    });
    Ok(())
}

/// W1：聚焦主窗口（show + unminimize + set_focus）。
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// C 卡（MCP 独立原生窗口，2026-11-06）：`studio_open_mcp_settings`
// ─────────────────────────────────────────────────────────────────────────────

/// 窗口 label。**只存在于运行时**：
///   - 不进 `window-state.json`（那份只记主窗几何，见 `save_window_state`）；
///   - 不进 `bot-windows.json`（那是 bot 槽位配置，`open_bot_window` 的后端）。
/// 负控 = `tests/desktop/mcp-settings-window.test.ts` 的静态守卫（关窗后两文件都不得出现它）。
const MCP_SETTINGS_LABEL: &str = "mcp-settings";

/// 该窗**唯一**允许停留的路径前缀（裁定四十七 d）。
const MCP_SETTINGS_PATH: &str = "/mcp-settings";

/// 该窗的页面 URL：与工作台同源（同一次 `config.json` 读取），只换路径。
fn mcp_settings_url() -> String {
    let (host, port) = studio_host_port();
    format!("http://{}:{}{}", host, port, MCP_SETTINGS_PATH)
}

/// 回环判定。只认字面回环地址 —— `0.0.0.0` / 局域网 IP / 域名一律不算。
fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

/// 导航策略（**纯函数**，可单测）：该窗只准停在「http + 回环 host + 本机端口 + /mcp-settings 前缀」。
///
/// 为什么必须是白名单而不是黑名单：这个窗里躺着**宿主全权 token**
/// （裁定四十七 三的 P2 未收口项），一旦被导航到远端页面，
/// 该页面就继承了 token ⇒ 宿主全权失守。所以除白名单外一律 false。
fn mcp_settings_navigation_allowed(target: &Url, port: u16) -> bool {
    if target.scheme() != "http" {
        return false;
    }
    let host = match target.host_str() {
        Some(h) => h,
        None => return false,
    };
    if !is_loopback_host(host) {
        return false;
    }
    if target.port_or_known_default() != Some(port) {
        return false;
    }
    target.path().starts_with(MCP_SETTINGS_PATH)
}

/// 拒绝导航的日志行（裁定四十七 d：拒绝要**可 grep**）。
///
/// ⚠️ 只记 scheme / host / port / path —— **不记 query、不记 userinfo**：
/// 被拒的 URL 里可能带着对方塞进来的凭据，写进日志等于换一个地方泄漏。
fn mcp_settings_nav_denied_line(target: &Url) -> String {
    format!(
        "[studio] level=warn mcp-settings navigation denied: scheme={} host={} port={} path={}",
        target.scheme(),
        target.host_str().unwrap_or("-"),
        target
            .port_or_known_default()
            .map(|p| p.to_string())
            .unwrap_or_else(|| "-".to_string()),
        target.path()
    )
}

/// 该窗的 init script。
///
/// 三件事，缺一件这张卡就不成立：
///   ① 注入 token（裁定四十七 三）：**走 init script，不落 HTML** —— 页面本体不含秘密，
///      所以「页面壳免鉴权」不等于「秘密免鉴权」；
///   ② 只暴露 `__studioOpenMcpSettings()` 一个闭包（与 `__studioRequestGrant` 同套路）；
///   ③ **捕获后删掉裸 `__TAURI_INTERNALS__`** —— 这才是「远端页面拿不到裸 invoke」那句
///      断言的实现（只捕获不删除，页面照样能自己 `internals.invoke(...)` 打任意 command）。
///
/// ⚠️ P2（已登记、本卡不收）：注入的是**宿主全权 token**，而该窗只需要
/// `/v1/mcp/servers*`。scope 化要一起动 `server.ts` 的 Bearer 校验与 token ring，
/// 混进来会把两件事都做坏 ⇒ 另立卡。在那之前：**该窗一旦被 XSS = 宿主全权失守**。
fn mcp_settings_init_script(token: &str, origin: &str) -> String {
    let token_js = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    let origin_js = serde_json::to_string(origin).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(){{\n\
          try {{\n\
            var internals = window.__TAURI_INTERNALS__;\n\
            window.__STUDIO_TOKEN__ = {token};\n\
            window.__STUDIO_API_ORIGIN__ = {origin};\n\
            if (internals && typeof internals.invoke === 'function') {{\n\
              window.__studioOpenMcpSettings = function () {{\n\
                return internals.invoke('studio_open_mcp_settings', {{}});\n\
              }};\n\
            }}\n\
            try {{ delete window.__TAURI_INTERNALS__; }} catch (e) {{}}\n\
          }} catch (e) {{ /* 注入失败 → 页面 fail-visible，不静默 */ }}\n\
        }})();\n",
        token = token_js,
        origin = origin_js
    )
}

/// 读 `config.json` 的 `token`（页面调 `/v1/mcp/servers*` 用的 Bearer）。
/// 读不到就返回空串，由调用方 fail-closed。
fn host_token_from_config() -> String {
    std::fs::read_to_string(config_dir().join("config.json"))
        .ok()
        .as_deref()
        .and_then(|s| serde_json::from_str::<StudioConfig>(s).ok())
        .map(|c| c.token)
        .unwrap_or_default()
}

/// C 卡：打开 MCP 设置独立窗口。
///
/// 幂等：label 已存在 → show + unminimize + focus，不重复建窗（与 `open_workbench` 同）。
/// 建窗**必须离开 IPC 回调**：wry 建 webview 是「投递 + rx.recv() 阻塞」，在 IPC 回调里
/// 等于主线程自锁（详见 `open_workbench` 那段根因注释）。故同样丢工作线程 + inflight 闸。
///
/// 生命周期：**绑 opener、关窗即毁**（不拦 `CloseRequested`、不 `hide()`），
/// 也不写任何窗口状态文件 —— 这三个「不」是本卡的负控对象。
#[tauri::command]
fn studio_open_mcp_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MCP_SETTINGS_LABEL) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }

    // token 拿不到 ⇒ **不开窗**（不开一个「打开了但什么都做不了」的空窗）。
    // fail-closed 并留一行可 grep 日志，避免表现为「按钮没反应」。
    let token = host_token_from_config();
    if token.is_empty() {
        grant_log(
            "[studio] level=warn mcp-settings: no-token (config.json missing/empty) → window not opened",
        );
        return Err("no-token".to_string());
    }

    let (host, port) = studio_host_port();
    let url = Url::parse(&mcp_settings_url()).map_err(|e| format!("invalid mcp-settings url: {}", e))?;
    let origin = format!("http://{}:{}", host, port);
    let script = mcp_settings_init_script(&token, &origin);

    if !inflight_begin(MCP_SETTINGS_LABEL) {
        p0_log("mcp-settings build skipped (already inflight)");
        return Ok(());
    }
    std::thread::spawn(move || {
        p0_log("mcp-settings build begin (worker)");
        let built = WebviewWindowBuilder::new(&app, MCP_SETTINGS_LABEL, WebviewUrl::External(url))
            .title("DeepSeek++ Studio · MCP 服务器")
            .inner_size(960.0, 720.0)
            .min_inner_size(720.0, 520.0)
            .initialization_script(&script)
            // 导航白名单：非白名单一律拒 + 写一行可 grep 日志（裁定四十七 d）。
            .on_navigation(move |target| {
                let allowed = mcp_settings_navigation_allowed(target, port);
                if !allowed {
                    grant_log(&mcp_settings_nav_denied_line(target));
                }
                allowed
            })
            .build();
        p0_log(format!(
            "mcp-settings build ok={} tracked={:?}",
            built.is_ok(),
            app.webview_windows().keys().collect::<Vec<_>>()
        ));
        if let Err(e) = built {
            eprintln!("[studio] failed to create mcp-settings window: {}", e);
        }
        inflight_end(MCP_SETTINGS_LABEL);
    });
    Ok(())
}

/// W2（20261023 用户定调的窗口设计）：主窗口 = 主 bot；bot 窗口按需拉起。
///
/// 启动时不再按 bot-windows.json 建窗（那是 v0.24 行为，配置残留一次就多开 N 个窗口，
/// 实测出现过「启动即 4 个窗口」）。聊天室路径要建窗时调 `open_bot_window`，
/// 由它把 setup 时算好的注入上下文取出来复用。
struct BotWindowContext {
    base_script: String,
    disable_inject: bool,
}

/// 主窗口自己的 WebView2 profile（Tauri 默认 = data_local_dir/<identifier>/EBWebView）。
/// 预留给 plan_bot_windows 当「已占用 profile」——避开它，否则 bot 窗口的 dataDir
/// 撞上主 profile = 主账号被复制进第二个窗口。
fn main_profile_dirs() -> Vec<std::path::PathBuf> {
    dirs::data_local_dir()
        .map(|d| vec![d.join("com.deepseek.studio").join("EBWebView")])
        .unwrap_or_default()
}

/// 真正建一个 bot 窗口（幂等由调用方保证）。
/// 主窗口（label="main"）不在这里建；这里只处理带 botId 的独立窗口：
/// 独立 WebView2 data_directory 隔离登录态 + 注入带 __studioBotId 的脚本 + host token。
fn create_bot_window(
    app: &tauri::AppHandle,
    ctx: &BotWindowContext,
    label: &str,
    bot_id: &str,
    visible: bool,
    data_dir: std::path::PathBuf,
) -> Result<(), String> {
    let mut builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(Url::parse(CHAT_URL).expect("invalid chat url")),
    )
    .title(format!("DeepSeek++ Studio [{}]", bot_id))
    .visible(visible)
    .inner_size(1280.0, 800.0);

    // TD-02：bot 窗口注入的是 bootstrap grant（绑 aud=bot:<id>），不再是 config.token。
    // 拼在 botId 声明之前，entry.ts 的 createHostClient 即可读到 window.__studioGrant。
    if !ctx.disable_inject {
        let grant_script = load_host_grant_script(&format!("bot:{}", bot_id));
        let with_bot = inject_with_bot_id(&ctx.base_script, bot_id);
        builder = builder.initialization_script(&format!("{}{}", grant_script, with_bot));
    }

    let _ = std::fs::create_dir_all(&data_dir);
    builder = builder.data_directory(data_dir.clone());

    builder
        .build()
        .map_err(|e| format!("failed to create bot window {:?}: {:?}", label, e))?;
    eprintln!(
        "[studio] bot window created on demand: label={:?} visible={} profile={:?}",
        label, visible, data_dir
    );
    Ok(())
}

/// W2：按需打开一个 bot 窗口（主 bot 进入聊天室时才调）。
///
/// 幂等：label 已存在则 show + unminimize + focus，不重复建窗。
/// 复用 plan_bot_windows 的「1 槽位 : 1 账号 : 1 窗口」判定：dataDir 缺失时按
/// botId 派生独立 profile；撞上主 profile 等保留目录则**如实报错**（fail-closed），
/// 绝不静默回退成共享 profile。
#[tauri::command]
fn open_bot_window(
    app: tauri::AppHandle,
    bot_id: String,
    data_dir: Option<String>,
) -> Result<(), String> {
    let ctx = app
        .try_state::<BotWindowContext>()
        .ok_or_else(|| "bot window context not initialised".to_string())?;
    let label = sanitize_window_label(&bot_id);

    // 已在屏幕上 → 聚焦返回（幂等路径）。
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }

    let entry = BotWindowConfig {
        bot_id: bot_id.clone(),
        visible: true,
        data_dir,
    };
    for plan in plan_bot_windows(std::slice::from_ref(&entry), &main_profile_dirs()) {
        match plan {
            BotWindowPlan::Skip { bot_id, reason } => {
                eprintln!("[studio] bot window skipped ({:?}): {}", bot_id, reason);
                return Err(format!("bot window skipped ({:?}): {}", bot_id, reason));
            }
            BotWindowPlan::Create {
                label,
                bot_id,
                visible,
                data_dir,
            } => {
                if app.get_webview_window(&label).is_some() {
                    return Err(format!("duplicate window label {:?}", label));
                }
                // 并发幂等闸：同 label 已经在建就直接跳过（否则会建出多个窗）。
                if !inflight_begin(&label) {
                    p0_log(format!("bot window build skipped (already inflight): {}", label));
                    return Ok(());
                }
                // A（T-1 治本）：同 open_workbench —— 建窗移出 IPC 回调（主线程）。
                // wry 的建 webview 会「投递 + rx.recv() 阻塞等事件循环」，在 IPC 回调里
                // 等于主线程自锁（窗口半成品、Tauri 不登记、退出拖住收尾）。
                // 这里把建窗丢到工作线程：主线程立即返回，事件循环保持可用。
                let app_for_build = app.clone();
                let ctx_for_build = BotWindowContext {
                    base_script: ctx.base_script.clone(),
                    disable_inject: ctx.disable_inject,
                };
                std::thread::spawn(move || {
                    p0_log(format!("bot window build begin: {}", label));
                    match create_bot_window(&app_for_build, &ctx_for_build, &label, &bot_id, visible, data_dir) {
                        Ok(()) => p0_log(format!("bot window build ok: {}", label)),
                        Err(e) => {
                            eprintln!("[studio] bot window create failed: {}", e);
                            p0_log(format!("bot window build failed: {}", label));
                        }
                    }
                    inflight_end(&label);
                });
            }
        }
    }
    Ok(())
}

// ── TD-04：资源根与宿主入口解析 ──────────────────────────────────────────

/// 仓库根判定（TD-04 补缺）：必须**同时**有 `package.json` 与 `src-tauri/`。
///
/// 只看 `package.json` 是不够的：安装版在 `C:\Users\<user>\AppData\Local\...`
/// 向上找时，会在 **用户 home** 撞到一份不相干的 `package.json`，于是把 home
/// 当成项目根（20261103 实测：`project_root` 落到 `C:\Users\<user>`，
/// `logs/`、`trace` 会写进用户 home）。两个标记缺一不可。
fn looks_like_repo_root(dir: &std::path::Path) -> bool {
    dir.join("package.json").is_file() && dir.join("src-tauri").is_dir()
}

/// 项目根（开发树）：从 `start` 向上找**同时**命中 `package.json` + `src-tauri/` 的目录。
fn find_project_root(start: &std::path::Path) -> Option<std::path::PathBuf> {
    find_project_root_with(start, looks_like_repo_root)
}

/// `find_project_root` 的可注入版本（单测用假判定，不碰真实文件系统）。
fn find_project_root_with(
    start: &std::path::Path,
    looks_repo: impl Fn(&std::path::Path) -> bool,
) -> Option<std::path::PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if looks_repo(dir) {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

/// 项目根决策（TD-04 补缺）：
/// - **release（打包）**：**完全不信任向上搜索**，直接用 `app_data_dir()`。
///   安装版向上找必然穿过用户 home 这类无关目录，任何一次误命中都是错根
///   （错根 = logs/trace 写进用户 home、安装版行为依赖开发机布局）。
/// - **debug（开发树）**：允许向上搜索，但必须同时命中 `package.json` + `src-tauri/`。
///
/// `allow_repo_search` 由调用方传 `cfg!(debug_assertions)`，单测可显式控制两条分支。
fn resolve_project_root(
    exe_dir: &std::path::Path,
    app_data_dir: Option<std::path::PathBuf>,
    allow_repo_search: bool,
) -> Option<std::path::PathBuf> {
    if allow_repo_search {
        if let Some(root) = find_project_root(exe_dir) {
            return Some(root);
        }
    }
    app_data_dir
}

/// 宿主入口（TD-04）。
///
/// 候选顺序：
///   1. `<resource_dir>/host/main.mjs` —— 打包版（bundle.resources 的产物）；
///   2. `<project_root>/src-tauri/host/main.mjs` —— 开发树（`npm run build:host` 产物）；
///   3. 都不在：**debug** 回退 tsx 并打 WARN（开发者本机不能被卡死）；
///      **release** 直接专用退出码（安装版缺宿主文件是打包错误，不许静默降级）。
/// 去掉 Windows 扩展长度前缀（`\\?\` / `\\?\UNC\`）。
///
/// 为什么必须去：Tauri 的 `resource_dir()` 返回 verbatim 路径（`\\?\E:\...`），而 Node 的
/// CJS 入口解析（`resolveMainPath` → `realpathSync`）会把它当成盘符 `E:` →
/// `EISDIR: illegal operation on a directory, lstat 'E:'`（20261103 真机实测：
/// host entry 连续 6 次崩溃，sidecar gave up）。宿主是 node 进程，argv 与环境变量
/// 都必须是普通形式。代价：超过 260 字符的路径会变脆（本应用远未到该长度）。
fn strip_verbatim(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// 宿主入口形态决策（**可注入**，单测显式控制两条分支）。
///
/// `packaged = true` → 只认 `resource_dir`（release/装版），产物形态 `Distribution::Installed`；
/// `packaged = false` → 只认仓库内产物，或回退 tsx（dev），形态 `Distribution::Dev`。
///
/// 为什么把 `packaged` 做成形参而不是在函数里读 `cfg!(debug_assertions)`：
/// 单测要能**显式**覆盖两条分支（与 `resolve_project_root` 的 `allow_repo_search` 同一套做法）；
/// 且 `cfg!` 只分「debug/release 构建」，分不了「release 构建但从仓库运行」。
fn resolve_host_entry_with(
    packaged: bool,
    resource_dir: Option<&std::path::Path>,
    project_root: Option<&std::path::Path>,
) -> sidecar::HostEntry {
    resolve_host_entry_with_data_dir(packaged, resource_dir, project_root, None)
}

/// 同 [`resolve_host_entry_with`]，另接受 `data_dir`（装版 = `app_data_dir()`）。
///
/// 批 N+1 段 2：装版把 `STUDIO_CONFIG_DIR` / `STUDIO_LOG_DIR` 指到
/// `<data_dir>/config` 与 `<data_dir>/logs` —— **与段 3 首启迁移同批**，
/// 否则老用户配置/记忆「看起来消失」（PM 裁定③）。
/// `data_dir = None`（dev / 单测未给）→ 两个字段仍为 `None`，行为不变。
fn resolve_host_entry_with_data_dir(
    packaged: bool,
    resource_dir: Option<&std::path::Path>,
    project_root: Option<&std::path::Path>,
    data_dir: Option<&std::path::Path>,
) -> sidecar::HostEntry {
    // 装版才注入路径；dev 恒为 None（开发期行为逐字节不变）
    let injected_dirs = |packaged: bool| -> (Option<std::path::PathBuf>, Option<std::path::PathBuf>) {
        if !packaged {
            return (None, None);
        }
        match data_dir {
            Some(d) => (
                Some(strip_verbatim(&d.join("config"))),
                Some(strip_verbatim(&d.join("logs"))),
            ),
            None => (None, None),
        }
    };
    let has_ui = |root: &std::path::Path| {
        root.join("src").join("ui").join("agent.html").is_file()
    };

    // ── 开发构建：只认**仓库内**产物（`npm run build:host` 的输出）。
    //    刻意不认 resource_dir 下的同步副本（build:host 会往 target/debug/host 拷一份）：
    //    ① 副本可能是旧的，dev 应该跑仓库里最新的那份；
    //    ② 若认副本，「把 src-tauri/host/main.mjs 改名 → 应回退 tsx」这条 dev 回退验证
    //       就永远测不出来（总有副本兜着）。
    if !packaged {
        if let Some(root) = project_root {
            let script = root.join("src-tauri").join("host").join("main.mjs");
            if script.is_file() && has_ui(root) {
                return sidecar::HostEntry::Bundled {
                    script: strip_verbatim(&script),
                    resource_root: strip_verbatim(root),
                    // dev：工作目录 = 仓库根（logs/trace 落仓库 logs/trace，与开发态一致）
                    work_dir: strip_verbatim(root),
                    // dev 不吃 bundled node（仓库里没有 node/node.exe；就算有也不用，避免掩盖 PATH 问题）
                    node: None,
                    // 设计稿 §8.3：走的是 dev 分支 → Dev；两个目录**不注入**（开发期行为不变）
                    distribution: sidecar::Distribution::Dev,
                    config_dir: None,
                    log_dir: None,
                };
            }
        }
        let root = project_root
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        eprintln!(
            "[studio] WARN: 未找到仓库内宿主单文件 <root>/src-tauri/host/main.mjs → 回退 tsx（仅开发可用，打包版必须带 host/main.mjs）"
        );
        return sidecar::HostEntry::Tsx {
            project_root: root,
            distribution: sidecar::Distribution::Dev,
        };
    }

    // ── 打包版：只认 resource_dir。
    //    工作目录统一先算出来：release 用它承载可写数据（宿主 cwd / trace / 日志）。
    let work_dir = project_root
        .map(strip_verbatim)
        .unwrap_or_else(|| resource_dir.map(strip_verbatim).unwrap_or_else(|| std::path::PathBuf::from(".")));
    // 装版路径注入（`data_dir` = app_data_dir）：<data>/config 与 <data>/logs。
    let (cfg_dir, log_dir) = injected_dirs(true);
    if let Some(res) = resource_dir {
        let script = res.join("host").join("main.mjs");
        if script.is_file() && has_ui(res) {
            return sidecar::HostEntry::Bundled {
                script: strip_verbatim(&script),
                resource_root: strip_verbatim(res),
                // release：工作目录 = 数据目录（app_data_dir），**不是安装目录**
                // （安装目录可能只读 → logs/trace 写不进去）。
                work_dir: work_dir.clone(),
                // TD-04(a)：包内 node.exe（存在才用；不存在 → 回退 STUDIO_NODE → PATH）
                node: {
                    let p = res.join("node").join("node.exe");
                    if p.is_file() { Some(strip_verbatim(&p)) } else { None }
                },
                // 设计稿 §8.3：走 `:1130` 之后的 return → Installed（**必须**）
                distribution: sidecar::Distribution::Installed,
                // 批 N+1 段 2（PM 裁定③）：路径注入 —— 必须与段 3 首启迁移**同批**，
                // 否则老用户配置/记忆「看起来消失」。`data_dir = None`（dev/单测未给）→ 两个 None。
                config_dir: cfg_dir.clone(),
                log_dir: log_dir.clone(),
            };
        }
        if script.is_file() {
            eprintln!(
                "[studio] WARN: 资源根 {:?} 下缺 src/ui/agent.html —— /agent 面板会 404（其余 API 可用）",
                res
            );
            // 注意：**缺 agent.html 也仍是装版**（只是面板会 404）——
            // 漏掉这条就会把「缺面板的装版」判成 dev → 又写回 example-filesystem（设计稿 §8.3 第 ③ 条单测）。
            return sidecar::HostEntry::Bundled {
                script: strip_verbatim(&script),
                resource_root: strip_verbatim(res),
                work_dir: work_dir.clone(),
                node: {
                    let p = res.join("node").join("node.exe");
                    if p.is_file() { Some(strip_verbatim(&p)) } else { None }
                },
                distribution: sidecar::Distribution::Installed,
                config_dir: cfg_dir.clone(),
                log_dir: log_dir.clone(),
            };
        }
    }
    eprintln!("[studio] 宿主入口缺失：<resource_dir>/host/main.mjs 不存在。");
    eprintln!("[studio] 这是打包错误（bundle.resources 漏了 host/main.mjs）→ 先 `npm run build:host` 再打包。");
    std::process::exit(sidecar::EXIT_HOST_MISSING);
}

/// 生产调用点：形态由构建类型决定（debug = 开发树，release = 装版）。
fn resolve_host_entry(
    resource_dir: Option<&std::path::Path>,
    project_root: Option<&std::path::Path>,
    data_dir: Option<&std::path::Path>,
) -> sidecar::HostEntry {
    resolve_host_entry_with_data_dir(!cfg!(debug_assertions), resource_dir, project_root, data_dir)
}

fn main() {
    hide_orphan_console();

    // 远程调试口：默认常开 CDP，便于本地工具/自动化直连 WebView2。
    // 关闭方式：设置 STUDIO_DISABLE_CDP=1；换端口：STUDIO_CDP_PORT=<port>。
    // 端口选择：9222 是历史默认口，旧脚本都连它；空闲时优先用它，
    // 被 Chrome/Edge 等占用时退回 9223，避免互相抢占。
    // 若外部已自行设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS，则只做合并，不覆盖。
    if std::env::var_os("STUDIO_DISABLE_CDP").is_none() {
        let port = std::env::var("STUDIO_CDP_PORT").unwrap_or_else(|_| {
            let is_free = |p: u16| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok();
            if is_free(9222) {
                "9222".to_string()
            } else {
                "9223".to_string()
            }
        });
        let arg = format!("--remote-debugging-port={}", port);
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let merged = if existing.trim().is_empty() {
            arg
        } else if existing.contains("--remote-debugging-port") {
            existing
        } else {
            format!("{} {}", existing, arg)
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_workbench,
            focus_main_window,
            open_bot_window,
            studio_open_mcp_settings,
            studio_request_grant,
            updater::updater_check,
            updater::updater_install,
            updater::updater_progress
        ])
        // v0.30 单实例锁：第二个 deepseek-studio.exe 进程不再创建窗口，
        // 而是聚焦到已有主窗口（根治多实例 × N bot 窗口 = 窗口爆炸）。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // v0.32：正在退出时不要再把即将销毁的主窗口 show 出来。
            // 否则「关闭 → 立刻重新点图标」会把正在收尾的窗口闪一下再消失。
            if SHUTTING_DOWN.load(Ordering::SeqCst) {
                eprintln!("[studio] second instance ignored (shutting down)");
                return;
            }
            // 第二实例启动时：把已有主窗口提到前台、取消最小化、聚焦。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // v0.12 Phase 3：开机自启插件
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // v0.12 Phase 3：自动更新插件
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // TD-04 补缺：注入脚本的打包版来源（Tauri 资源目录）。
            // 提到块外：主窗口与 bot 窗口（base_script）都要用它找
            // `<resource_dir>/inject/entry.js`，否则安装版会借到开发树的产物。
            let resource_dir = app.path().resource_dir().ok();
            // 段 2 的数据根：主窗 WebView2 profile 与 HostEntry 的 config/log 注入都用它，
            // 在 setup 顶层声明一次 → 两处同源（不会出现「work_dir 一个根、profile 另一个根」）。
            let app_data_dir = app.path().app_data_dir().ok();
            // 自动更新：注册状态 + 启动后 60s 一次性检查（失败静默，见 updater.rs）
            updater::init_state(app.handle());
            updater::spawn_startup_check(app.handle().clone());
                // v0.12：受监管 sidecar 启动
            if std::env::var("STUDIO_DISABLE_HOST").is_err() {
                // TD-04(a)：包内 bundled node.exe 优先。先算出候选，再决定是否探活。
                // 干净机器上没有 PATH node 时，probe 也必须看 bundled —— 否则会误判 EXIT_NODE_MISSING。
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                let bundled_node = resource_dir
                    .as_ref()
                    .map(|r| r.join("node").join("node.exe"))
                    .filter(|p| p.is_file());
                if let Err(why) = sidecar::probe_node_choice(bundled_node.as_deref()) {
                    eprintln!("[studio] 宿主启动失败：找不到可用的 Node.js（{why}）");
                    eprintln!(
                        "[studio] 请安装 Node.js ≥24（https://nodejs.org/），或用 STUDIO_NODE 指定 node 可执行文件路径。"
                    );
                    std::process::exit(sidecar::EXIT_NODE_MISSING);
                }
                // TD-04：不再有硬编码兜底。开发树向上找 package.json；安装版退回 app_data_dir。
                // TD-04 补缺：**release（打包）不走上向搜索**，直接用 app_data_dir；
                // 只有 debug（开发树）才允许向上找，且必须同时命中 package.json + src-tauri/。
                // 20261103 实测：安装版向上找会撞到用户 home 里的杂散 package.json，
                // 把 home 当项目根 → logs/trace 写进用户 home。
                let project_root = resolve_project_root(
                    &exe_dir,
                    app.path().app_data_dir().ok(),
                    cfg!(debug_assertions),
                );
                eprintln!(
                    "[studio] project_root: {:?} resource_dir: {:?}",
                    project_root, resource_dir
                );
                // 段 2：装版的路径注入以 `app_data_dir()` 为根（<data>/config、<data>/logs）。
                // 装配入口同源 → 不会出现「work_dir 一个根、config_dir 另一个根」。
                let host_entry = resolve_host_entry(
                    resource_dir.as_deref(),
                    project_root.as_deref(),
                    app_data_dir.as_deref(),
                );
                // P0 卡 (C)：把 grant / chat-config 的日志落点定下来 ——
                // 必须**在页面初始化脚本生成之前**，否则那几条 `[studio] grant: …`
                // 会退回 eprintln!（装版无控制台 ⇒ 丢失），等于白加。
                // 落点与 sidecar 自己那份日志同目录（`HostEntry::log_dir()` 优先，
                // dev 回落 `dirs::config_dir()/deepseek-studio/logs`），文件名带 pid + ms，
                // 不会与 `sidecar-<ms>.log` 撞名。
                {
                    let log_dir = host_entry
                        .log_dir()
                        .map(std::path::PathBuf::from)
                        .or_else(|| {
                            dirs::config_dir().map(|d| d.join("deepseek-studio").join("logs"))
                        });
                    if let Some(dir) = log_dir {
                        let _ = std::fs::create_dir_all(&dir);
                        set_sidecar_log_path(Some(
                            dir.join(format!("studio-main-{}.log", std::process::id())),
                        ));
                    }
                }
                match &host_entry {
                    sidecar::HostEntry::Bundled { script, resource_root, work_dir, node, distribution, config_dir, log_dir } => {
                        eprintln!("[studio] host entry: bundled {:?}", script);
                        eprintln!("[studio] STUDIO_RESOURCE_ROOT: {:?}", resource_root);
                        // 工作目录（可写）：宿主把 logs/trace 写在这里 → 必须是数据目录，不是安装目录
                        eprintln!("[studio] host work_dir: {:?}", work_dir);
                        eprintln!("[studio] bundled node: {:?}", node);
                        // 设计稿 §8.3：形态与两个目录一次打出，真机一眼可核「装版到底注入了什么」。
                        eprintln!("[studio] STUDIO_DISTRIBUTION: {}", distribution.as_env());
                        eprintln!("[studio] STUDIO_CONFIG_DIR: {:?}", config_dir);
                        eprintln!("[studio] STUDIO_LOG_DIR: {:?}", log_dir);
                    }
                    sidecar::HostEntry::Tsx { project_root, distribution } => {
                        eprintln!("[studio] host entry: tsx (dev fallback) {:?}", project_root);
                        eprintln!("[studio] STUDIO_DISTRIBUTION: {}", distribution.as_env());
                    }
                }

                let (handle, event_rx) = sidecar::SidecarHandle::start(host_entry);
                let app_handle = app.handle().clone();

                tauri::async_runtime::spawn(async move {
                    while let Ok(event) = event_rx.recv() {
                        let payload = serde_json::to_string(&event).unwrap_or_default();
                        let _ = app_handle.emit("sidecar://event", payload);
                    }
                });

                app.manage(handle);
                eprintln!("[studio] sidecar supervisor started");
            }

            let disable_inject = std::env::var("STUDIO_DISABLE_INJECT").is_ok();

            // v0.12 Phase 3：恢复窗口状态
            let win_state = load_window_state();
            let mut main_builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(Url::parse(CHAT_URL).expect("invalid chat url")),
            )
            .title(if disable_inject {
                "DeepSeek++ Studio (NO-INJECT)"
            } else {
                "DeepSeek++ Studio"
            });

            if !disable_inject {
                // v0.28：主窗口注入聊天室配置（token + roomId + members），供聊天室 UI 连 /agent-ws。
                // 无配置时返回空串，不影响入口脚本。仅主窗口注入（bot 窗口不需要聊天室）。
                let chat_config_script = load_studio_chat_config_script();
                // P0 卡 (A)（PM 裁定四十一）：**不再在建窗时烤一张 60s 券**（它 60s 就过期，
                // 而页面往往更晚才连 —— 这正是「1288 拒 / 0 accepted」的直接成因）。
                // 改为注入取券闭包：页面每次连接/重连前现取。
                let grant_script = grant_request_closure_script();
                let init_script = format!(
                    "{}{}{}",
                    chat_config_script,
                    grant_script,
                    load_init_script(resource_dir.as_deref())
                );
                main_builder = main_builder.initialization_script(&init_script);
            }

            // 主窗 WebView2 `data_directory`：**PM 裁定五（2026-11-06）明确撤销，不要启用**。
            //
            // 曾按段 2 实现过，裁撤理由（三条，全部成立）：
            //   ① `%LOCALAPPDATA%\com.deepseek.studio\EBWebView` 是 Tauri/WebView2 的
            //      **标准落点**（本机 26 个应用实测都在 local 的 identifier 目录）；
            //   ② 我们的 `<data>` = `app_data_dir()` = `%APPDATA%\com.deepseek.studio`
            //      （**Roaming**）—— 把 86 MB 且持续增长的浏览器缓存搬进漫游目录，
            //      域环境下会被同步，**比现状更差**；
            //   ③ 顺带免掉「老用户升级后要重新登录一次」这个可见回归与首启拷贝延迟。
            //
            // 收敛目标是「**配置与业务数据**离开 `~/.config` 与 roaming 根」，
            // webview 缓存本就在 local，**不在收敛目标内**（见设计稿 §8.6）。
            // 替代待办记 §9：NSIS 卸载器清理 `%LOCALAPPDATA%\com.deepseek.studio`（卸载残留）。
            //
            // ⚠️ 谁要重新打开这条，先读上面三条 —— 别只看到「目录 ② 没被治」就再写一遍。

            // 应用保存的窗口大小和位置
            if let (Some(w), Some(h)) = (win_state.width, win_state.height) {
                main_builder = main_builder.inner_size(w, h);
            } else {
                main_builder = main_builder.inner_size(1280.0, 800.0);
            }
            if let (Some(x), Some(y)) = (win_state.x, win_state.y) {
                main_builder = main_builder.position(x as f64, y as f64);
            }

            let win = main_builder.build().expect("failed to create window");

            // 恢复最大化状态
            if win_state.maximized == Some(true) {
                let _ = win.maximize();
            }

            // W2（20261023 用户定调）：启动时**只建主窗口**。
            // 主窗口是「主 bot」；只有当主 bot 进入聊天室时，才按 chatRooms 的
            // memberPersonas 逐个调 open_bot_window 按需拉起 bot 窗口。
            // 此前这里是无条件按 bot-windows.json 建窗（v0.24 行为）：配置里残留几条
            // 就多开几个窗口，实测出现过「启动即 4 个窗口」，与设计不符。
            // plan_bot_windows 及其单测保留 —— 按需建窗那条路径仍要走同一套
            // 「1 槽位 : 1 账号 : 1 窗口」判定。
            let base_script = if !disable_inject {
                load_init_script(resource_dir.as_deref())
            } else {
                String::new()
            };
            // 按需建窗时要用到这两样，寄存到 managed state 里（setup 之后主线程
            // 拿不到这个闭包，只能经 State 取）。
            app.manage(BotWindowContext {
                base_script,
                disable_inject,
            });

            // v0.12 Phase 3：系统托盘
            #[cfg(feature = "tray-icon")]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                // 统一 UI：桌面主入口只保留主窗口；Workbench 转为手机远程端，
                // 不再从托盘暴露桌面第二客户端。open_workbench 命令保留给兼容/诊断调用。
                let tray_menu = MenuBuilder::new(app)
                    .item(&MenuItemBuilder::with_id("show", "显示主窗口").build(app)?)
                    .item(&MenuItemBuilder::with_id("hide", "隐藏主窗口").build(app)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("quit", "退出").build(app)?)
                    .build()?;
                let tray = TrayIconBuilder::with_id("main-tray")
                    // 显式给图标：Windows 上未设置 icon 时托盘不会创建可视项。
                    // 缺失时退回 tauri.conf bundle.icon 解析出的默认窗口图标。
                    .icon(
                        app.default_window_icon()
                            .cloned()
                            .expect("default window icon must resolve from tauri.conf bundle.icon"),
                    )
                    .tooltip("DeepSeek++ Studio")
                    .menu(&tray_menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.hide();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(win) = app.get_webview_window("main") {
                                if win.is_visible().unwrap_or(false) {
                                    let _ = win.hide();
                                } else {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;
                app.manage(tray);
                eprintln!("[studio] system tray initialized");
            }

            Ok(())
        })
        // v0.12：优雅关闭钩子 + 窗口状态保存
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 用户视角最先：**先 hide，再打任何日志**。
                // 20261031 实测（roundT1-exit-*）：日志重定向到 E:\NAS（网络盘），
                // 单次写 ≈36ms；关闭路径一次要写十几行，光日志就把「300ms 内主窗不可见」
                // 吃掉（实测 handler 内 358ms 才走到 hide）。hide 是纯 Win32 调用，先做它。
                if label == "main" {
                    // 20261103 实测（T1fix-workbench / T1fix-bot）：只藏主窗时，OS 会把前台
                    // 移交给同 app 里仍然可见的第二个窗 —— 采样为「关闭后可见窗 >0 持续
                    // 1,121ms / 2,604ms」「前台落到工作台/bot 窗 hits=4 / 9」。
                    // 根因是顺序：主窗 hide 在入口执行，`hide other:` 要等到 +289ms 后那段循环。
                    // 修法：**先藏其余窗、再藏主窗**，让前台没有可移交的目标（焦点闪消失）。
                    // 只做 hide；destroy 仍留在下方那段（两者顺序敏感，勿合并）。
                    for (other_label, other) in window.app_handle().webview_windows() {
                        if other_label != label {
                            let _ = other.hide();
                        }
                    }
                    let _ = window.hide();
                    p0_log("hide main (first, before any log write)");
                }
                eprintln!("[studio] CloseRequested for window: {}", label);
                // P0 定位：CloseRequested 入口（任何窗口都打），与后续 p0 时间戳同源，便于对齐整条退出时序。
                p0_log(format!("close-requested: {}", label));
                // v0.24：bot 窗口直接放行原生关闭——不保存几何（避免污染主窗口状态）、
                // 也不关闭 sidecar（它是全应用共享的常驻宿主进程）。仅主窗口走下方优雅关闭。
                if label != "main" {
                    eprintln!(
                        "[studio] bot window {:?} closed (state/sidecar untouched)",
                        label
                    );
                    // P0 卡 (A) 配套：窗口销毁 → 清掉它的取券限流计数。
                    // **没有回收的「上界」= 看着有保护、实际单调增长**（今天抓过四次）。
                    if let Ok(mut g) = GRANT_RATE.lock() {
                        if let Some(map) = g.as_mut() {
                            if grant_rate_forget(map, &label) {
                                grant_log(&format!(
                                    "[studio] grant: rate-reset label={} (window destroyed)",
                                    label
                                ));
                            }
                        }
                    }
                    return;
                }
                // 退出流程已经启动：放行后续的关闭请求（例如 destroy 触发的重入）。
                if SHUTTING_DOWN.load(Ordering::SeqCst) {
                    return;
                }
                SHUTTING_DOWN.store(true, Ordering::SeqCst);
                // P0 定位：确认走的是「主窗关闭 → 接管退出流程」这条分支（而不是被 SHUTTING_DOWN 提前 return）。
                p0_log("close-flow begin (main)");

                // 用户视角优先：**先藏/销毁窗口，再做跨线程调用与磁盘记账**。
                // 20261031 实测（roundT1-fin3-*）：`api.prevent_close()` 是跨线程调用、
                // `save_window_state` 要写盘，两者排在 hide 之前会把「关闭后 300ms 内主窗不可见」
                // 拖到 780–1737ms。
                // 顺序：主窗 hide（已在 handler 入口做过）→ 其余窗 hide+destroy → prevent_close
                // → 保存状态 → 收尾线程。
                for (other_label, other) in window.app_handle().webview_windows() {
                    if other_label != label {
                        let _ = other.hide();
                        p0_log(format!("hide other: {}", other_label));
                        let _ = other.destroy();
                        p0_log(format!("destroy other: {}", other_label));
                    }
                }

                api.prevent_close();
                p0_log("prevent_close done");

                // v0.12 Phase 3：保存窗口状态（size 必存，position 尽力）
                let mut state = WindowState::default();
                if let Ok(size) = window.inner_size() {
                    state.width = Some(size.width as f64);
                    state.height = Some(size.height as f64);
                    eprintln!("[studio] window size: {}x{}", size.width, size.height);
                }
                if let Ok(position) = window.outer_position() {
                    state.x = Some(position.x);
                    state.y = Some(position.y);
                }
                state.maximized = Some(window.is_maximized().unwrap_or(false));
                save_window_state(&state);
                eprintln!("[studio] window state saved");

                // 优雅关闭 sidecar（R5：移到后台线程，sleep 不阻塞主线程）
                let app_handle = window.app_handle().clone();
                let label = window.label().to_string();
                std::thread::spawn(move || {
                    // P0 打点 1/3：后台收尾线程是否真的起来（没起来 = spawn 之前就卡）。
                    p0_log("exit-closure entered");

                    // 退出硬兜底 watchdog：从**用户点关闭这一刻**开始计时（不是从排队之后）。
                    // 根因（20261103）：长会话后 run_on_main_thread 可能返回 Err → teardown 闭包
                    // 永不执行 → process::exit(0) 永不发生 → 进程 90s+ 不死。
                    // 而 do_shutdown 在长会话下自身就要 ~4.9s，所以预算必须覆盖「整条收尾」，
                    // 从关窗起算，超时即退——用户点了关闭，进程必须在可预期时间内消失。
                    // 取舍：正常路径 <2s 走完，watchdog 不触发；真挂住时牺牲 WebView 优雅回收，
                    //       退出前再回收一次本 app 的 WebView2，尽量不给下一次启动留残留。
                    std::thread::spawn(|| {
                        std::thread::sleep(EXIT_DEADLINE);
                        p0_log(format!(
                            "WATCHDOG: still alive {:?} after close → force exit",
                            EXIT_DEADLINE
                        ));
                        let killed = terminate_app_webviews();
                        p0_log(format!("WATCHDOG: terminated app webviews = {}", killed));
                        std::process::exit(0);
                    });

                    if let Some(handle) = app_handle.try_state::<sidecar::SidecarHandle>() {
                        p0_log("sidecar shutdown begin");
                        handle.shutdown();
                        p0_log("sidecar shutdown returned");
                        // 原来这里固定 sleep 500ms，等 sidecar 自己优雅退出。
                        // 现在 shutdown() 内部已是决定性的进程树结束（TerminateProcess），
                        // 再等这 500ms 纯属给「关闭慢」加账 —— 去掉。
                    } else {
                        p0_log("no sidecar state; skip shutdown");
                    }
                    // 窗口操作统一回主线程；先销毁其余窗口、最后销毁主窗口，
                    // 保证焦点始终落在即将消失的主窗口上，不再闪。
                    let app_for_windows = app_handle.clone();
                    let queued = app_handle.run_on_main_thread(move || {
                        p0_log("main-thread teardown entered");
                        let teardown_label = label.clone();
                        let all: Vec<String> = app_for_windows
                            .webview_windows()
                            .keys()
                            .cloned()
                            .collect();
                        p0_log(format!("teardown window set: {:?}", all));
                        for (other_label, other) in app_for_windows.webview_windows() {
                            if other_label != label {
                                let _ = other.hide();
                                // P0 打点 2/3：每个窗 destroy 前后。
                                p0_log(format!("destroy begin: {}", other_label));
                                let _ = other.destroy();
                                p0_log(format!("destroy done: {}", other_label));
                            }
                        }
                        if let Some(main) = app_for_windows.get_webview_window(&teardown_label) {
                            p0_log("destroy begin: main");
                            let _ = main.destroy();
                            p0_log("destroy done: main");
                        } else {
                            p0_log("main window already gone before destroy");
                        }
                        // B（T-1 兜底）：先回收本 app 归属的 WebView2（含 Tauri 未登记的野窗口），
                        // 否则事件循环收尾会一直等这些 WebView2 → app.exit(0) 只是"请求"退出，
                        // 进程永远退不掉（实测 30s 不退 + 强杀后残留 6 个 msedgewebview2）。
                        let killed_webviews = terminate_app_webviews();
                        p0_log(format!("teardown: terminated app webviews = {}", killed_webviews));
                        // P0 打点 3/3：调 exit 之前。
                        p0_log("calling app.exit(0)");
                        app_for_windows.exit(0);
                        p0_log("app.exit(0) returned");
                        // 收尾：app.exit(0) 只是"请求"退出，事件循环仍可能等野 WebView2
                        // 而迟迟不结束（20261031 实测 exit 之后还要再拖十几秒）。
                        // WebView2 已在上面回收完毕，这里直接结束进程，跳过慢收尾。
                        p0_log("calling std::process::exit(0)");
                        std::process::exit(0);
                    });
                    // P0 打点 4/4：run_on_main_thread 返回调度结果。
                    //
                    // 现场事实（20261103 长会话，13:31 未修版 release，logs/verify-exit/longsess-release-p0.log）：
                    //   ① 关窗后 `run_on_main_thread queued ok=false`；
                    //   ② teardown 闭包没执行 → `process::exit(0)` 打不出来 → 进程 90s+ 不死（必须强杀）。
                    //
                    // **原先这里写的「长会话后主事件循环已停」是推测，已被同一份现场推翻**：
                    //   关窗后 +300s，`ThreadId(1)` 仍正常处理了第二次 `CloseRequested` → 主事件循环没停。
                    //   因此 `Err` 的真因**仍未证实**；候选：`do_shutdown` 在 ThreadId(4) 上耗时 4.87s
                    //   （同段日志 `do_shutdown total=4.87s`），与主线程那侧的排队时机重叠。
                    //
                    // 修法刻意**不依赖根因**：调度失败就自己 force exit —— 「进程一定死」这条
                    // 不能建立在尚未证实的因果推断上。
                    let queued_ok = queued.is_ok();
                    p0_log(format!("run_on_main_thread queued ok={}", queued_ok));
                    if !queued_ok {
                        // 与 watchdog 分支保持**同一行为**：先回收本 app 归属的 WebView2，再退出。
                        // 否则「进程一定死」会以留下孤儿 WebView2 为代价，把 T-1 的三项归零判据打掉。
                        p0_log("run_on_main_thread queue FAILED (rejected/lost; 主循环是否停未证实) → force exit(0)");
                        let killed = terminate_app_webviews();
                        p0_log(format!("force-exit: terminated app webviews = {}", killed));
                        std::process::exit(0);
                    }
                    // 排队成功时由线程开头那条 watchdog 兜底（它覆盖「排上了但永不执行」）。
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running deepseek-studio");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个空文件（含父目录）。
    fn touch_file(p: &std::path::Path) {
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir -p");
        std::fs::write(p, b"").expect("write");
    }

    /// 每次用独立临时目录，避免与并行用例互踩。
    fn fresh_tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "studio-hostentry-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("mk tmp");
        d
    }

    /// 造一个「像开发树」的目录：同时有 `package.json` 与 `src-tauri/`。
    fn make_repo_like(root: &std::path::Path) {
        touch_file(&root.join("package.json"));
        std::fs::create_dir_all(root.join("src-tauri")).expect("src-tauri");
    }

    /// 装版资源根：`<res>/host/main.mjs`（+ 可选 `<res>/src/ui/agent.html`）。
    fn make_resource_root(root: &std::path::Path, with_agent_html: bool) {
        touch_file(&root.join("host").join("main.mjs"));
        if with_agent_html {
            touch_file(&root.join("src").join("ui").join("agent.html"));
        }
    }

    fn distribution_of(entry: &sidecar::HostEntry) -> sidecar::Distribution {
        match entry {
            sidecar::HostEntry::Bundled { distribution, .. } => *distribution,
            sidecar::HostEntry::Tsx { distribution, .. } => *distribution,
        }
    }

    /// 设计稿 §8.3 Rust 单测 ①：**像开发树（`package.json` + `src-tauri/` 都在）但 exe 在
    /// `resource_dir` 内 → 必须判 `installed`**。
    ///
    /// 这条锁的是「不许用 `looks_like_repo_root` 当形态判据」：它只回答「能不能找到开发树」，
    /// 而形态判据是「实际走了哪条宿主入口分支」。装版 exe 恰落在含这两个标记的目录树下时，
    /// 若用「找到开发树」判 dev，就会又写回 `example-filesystem` + 建技能目录。
    #[test]
    fn packaged_build_from_repo_like_dir_is_installed() {
        let tmp = fresh_tmp("installed-with-repo");
        let res = tmp.join("res");
        let repo_like = tmp.join("repo-like");
        make_resource_root(&res, true);
        make_repo_like(&repo_like);

        // packaged = true（release 构建）→ 只认 resource_dir
        let entry =
            resolve_host_entry_with(true, Some(res.as_path()), Some(repo_like.as_path()));
        assert_eq!(
            distribution_of(&entry),
            sidecar::Distribution::Installed,
            "release 构建即便处在该开发树目录下，也必须判 installed"
        );
        match entry {
            sidecar::HostEntry::Bundled { work_dir, config_dir, log_dir, .. } => {
                // 可写数据目录 = app_data_dir（此测试里传入的 project_root）
                assert_eq!(work_dir, repo_like);
                // 批 N：路径注入属段 2（批 N+1），此批恒 None → 装版行为逐字节不变
                assert!(config_dir.is_none(), "批 N 不得注入 STUDIO_CONFIG_DIR");
                assert!(log_dir.is_none(), "批 N 不得注入 STUDIO_LOG_DIR");
            }
            sidecar::HostEntry::Tsx { .. } => panic!("装版不应回退 tsx"),
        }
    }

    /// 设计稿 §8.3 Rust 单测 ②：**debug 分支 → `dev`**（且两个目录不注入，dev 行为不变）。
    #[test]
    fn dev_branch_is_dev_and_injects_no_dirs() {
        let tmp = fresh_tmp("dev-branch");
        let repo = tmp.join("repo");
        touch_file(&repo.join("src-tauri").join("host").join("main.mjs"));
        touch_file(&repo.join("src").join("ui").join("agent.html"));
        make_repo_like(&repo);

        let entry = resolve_host_entry_with(false, None, Some(repo.as_path()));
        assert_eq!(distribution_of(&entry), sidecar::Distribution::Dev);
        match entry {
            sidecar::HostEntry::Bundled { config_dir, log_dir, work_dir, .. } => {
                assert_eq!(work_dir, repo, "dev 的 work_dir 仍是仓库根");
                assert!(config_dir.is_none(), "dev 不得注入 STUDIO_CONFIG_DIR");
                assert!(log_dir.is_none(), "dev 不得注入 STUDIO_LOG_DIR");
            }
            sidecar::HostEntry::Tsx { .. } => panic!("仓库内宿主单文件存在时应走高优先级分支"),
        }
    }

    /// 设计稿 §8.3 Rust 单测 ③（**最容易漏的一条**）：`resource_dir` 内**缺
    /// `src/ui/agent.html` → 仍必须是 `installed`**。
    ///
    /// 依据 `main.rs` release 分支的第二次 return：缺面板时**也返回 Bundled**（只打 WARN）。
    /// 漏了这条，打包漏带面板的装版会被判成 dev → 用户机又出现假 MCP + 空技能目录。
    #[test]
    fn packaged_without_agent_html_is_still_installed() {
        let tmp = fresh_tmp("installed-no-agent-html");
        let res = tmp.join("res");
        let data = tmp.join("appdata");
        make_resource_root(&res, false); // 刻意不建 src/ui/agent.html
        std::fs::create_dir_all(&data).expect("appdata");

        let entry = resolve_host_entry_with(true, Some(res.as_path()), Some(data.as_path()));
        assert_eq!(
            distribution_of(&entry),
            sidecar::Distribution::Installed,
            "缺 agent.html 只是面板 404，形态仍是装版"
        );
        match entry {
            sidecar::HostEntry::Bundled { config_dir, log_dir, .. } => {
                // 批 N：两个路径字段恒 None（注入属段 2/批 N+1）
                assert!(config_dir.is_none());
                assert!(log_dir.is_none());
            }
            sidecar::HostEntry::Tsx { .. } => panic!("装版不得回退 tsx"),
        }
    }

    /// 形态 → env 值的映射（Node 侧 `resolveStudioDistribution` 只认这两个字面量）。
    #[test]
    fn distribution_env_values_are_stable() {
        assert_eq!(sidecar::Distribution::Installed.as_env(), "installed");
        assert_eq!(sidecar::Distribution::Dev.as_env(), "dev");
    }

    /// 批 N+1 段 2（PM 裁定③ 2026-11-06）：装版**必须**注入两个路径 env，值 = `<data>/config`
    /// 与 `<data>/logs`。
    ///
    /// 这条替换了批 N 的 `batch_n_does_not_inject_paths`（那条锁的是「本批不许注入」，
    /// 本批正是要注入 → 过时断言，按群纪律第 4 条「删过时断言必须补真回归断言」换成反向断言）。
    #[test]
    fn batch_n1_injects_config_and_log_dirs_when_data_dir_given() {
        let tmp = fresh_tmp("n1-inject");
        let res = tmp.join("res");
        make_resource_root(&res, true);
        let data = tmp.join("appdata");
        std::fs::create_dir_all(&data).expect("appdata");

        match resolve_host_entry_with_data_dir(
            true,
            Some(res.as_path()),
            Some(data.as_path()),
            Some(data.as_path()),
        ) {
            sidecar::HostEntry::Bundled { distribution, config_dir, log_dir, work_dir, .. } => {
                assert_eq!(distribution, sidecar::Distribution::Installed);
                assert_eq!(
                    config_dir.as_deref(),
                    Some(data.join("config").as_path()),
                    "装版必须注入 STUDIO_CONFIG_DIR = <data>/config"
                );
                assert_eq!(
                    log_dir.as_deref(),
                    Some(data.join("logs").as_path()),
                    "装版必须注入 STUDIO_LOG_DIR = <data>/logs"
                );
                // 两个注入目录必须与 work_dir 同一个数据根（否则「config 在 A、trace 在 B」）
                assert_eq!(work_dir, data, "work_dir 应等于同一个 app_data_dir");
            }
            sidecar::HostEntry::Tsx { .. } => panic!("装版不应回退 tsx"),
        }
    }

    /// 段 2 的**反向**断言：dev 形态（不经 Rust 装版分支）**一个路径都不许注入** ——
    /// 开发期行为必须逐字节不变（这也是批 N 那条不变量的真正内核，保留下来）。
    #[test]
    fn batch_n1_dev_never_injects_paths_even_with_data_dir() {
        let tmp = fresh_tmp("n1-dev-noinject");
        let root = tmp.join("repo");
        // dev 分支的两个条件：仓库内产物 `<root>/src-tauri/host/main.mjs` **且** `<root>/src/ui/agent.html`
        touch_file(&root.join("src-tauri").join("host").join("main.mjs"));
        touch_file(&root.join("src").join("ui").join("agent.html"));
        let data = tmp.join("appdata");
        std::fs::create_dir_all(&data).expect("appdata");

        // dev 分支 + 显式给了 data_dir：仍然不许注入
        match resolve_host_entry_with_data_dir(
            false,
            None,
            Some(root.as_path()),
            Some(data.as_path()),
        ) {
            sidecar::HostEntry::Bundled { distribution, config_dir, log_dir, .. } => {
                assert_eq!(distribution, sidecar::Distribution::Dev);
                assert!(config_dir.is_none(), "dev 不得注入 STUDIO_CONFIG_DIR");
                assert!(log_dir.is_none(), "dev 不得注入 STUDIO_LOG_DIR");
            }
            sidecar::HostEntry::Tsx { .. } => panic!("仓库内宿主单文件存在时应走 Bundled(dev)"),
        }

        // 未给 data_dir 的装版（单测/老调用点）：两个字段仍为 None，等价于批 N 行为
        let res = tmp.join("res");
        make_resource_root(&res, true);
        match resolve_host_entry_with(true, Some(res.as_path()), Some(data.as_path())) {
            sidecar::HostEntry::Bundled { config_dir, log_dir, .. } => {
                assert!(config_dir.is_none());
                assert!(log_dir.is_none());
            }
            sidecar::HostEntry::Tsx { .. } => panic!("装版不应回退 tsx"),
        }
    }

    /// PM 裁定③ 追加要求：`window_state_path` 改认 env 后，**两形态各一条单测**。
    ///
    /// 装版：认 `STUDIO_CONFIG_DIR`（与 Node 侧同目录，用户文件夹里只有一处 deepseek-studio）；
    /// dev：无人注入 → 回落 `dirs::config_dir()/deepseek-studio`，**行为逐字节不变**。
    #[test]
    fn window_state_path_uses_env_when_injected() {
        let data = std::path::PathBuf::from("X:\\data");
        let injected = data.join("config");
        let got = window_state_path_with(Some(injected.to_str().unwrap()), Some(&data));
        assert_eq!(got, injected.join("window-state.json"));
    }

    #[test]
    /// P0 卡 (A)：限流口径（裁定三十三 2）—— 同窗口 1s 间隔 + 单窗口 200 张上限。
    ///
    /// 这是本命令引入的**新暴露面**：原本页面只能读到一张静态券，现在可无限现签。
    #[test]
    fn grant_rate_limit_enforces_interval_and_cap() {
        let mut map: std::collections::HashMap<String, GrantRateEntry> =
            std::collections::HashMap::new();
        // 首次放行
        assert!(grant_rate_check(&mut map, "main", 10_000).is_ok());
        // 间隔 < 1s → 拒
        assert_eq!(grant_rate_check(&mut map, "main", 10_500), Err("rate-limited"));
        // 间隔 ≥ 1s → 放行
        assert!(grant_rate_check(&mut map, "main", 11_000).is_ok());
        // 不同窗口互不影响（key = window.label()）
        assert!(grant_rate_check(&mut map, "bot:S1", 11_000).is_ok());
        // 单窗口上限：把计数推到上限
        let mut m2: std::collections::HashMap<String, GrantRateEntry> = std::collections::HashMap::new();
        for i in 0..GRANT_MAX_PER_WINDOW as u64 {
            assert!(grant_rate_check(&mut m2, "main", 100_000 + i * GRANT_MIN_INTERVAL_MS).is_ok());
        }
        let over = grant_rate_check(&mut m2, "main", 100_000 + GRANT_MAX_PER_WINDOW as u64 * GRANT_MIN_INTERVAL_MS);
        assert_eq!(over, Err("rate-limited"), "超过单窗口上限必须拒签");
    }

    /// **负控（PM 点名要求）**：窗口销毁后该 label 的计数条目必须真的消失 ——
    /// 只断言「size ≤ 上限」不算（那正是「看着有上界、实际单调增长」的那个反模式）。
    #[test]
    fn grant_rate_entries_are_dropped_when_window_destroyed() {
        let mut map: std::collections::HashMap<String, GrantRateEntry> =
            std::collections::HashMap::new();
        assert!(grant_rate_check(&mut map, "main", 1_000).is_ok());
        assert!(grant_rate_check(&mut map, "bot:S1", 1_000).is_ok());
        assert_eq!(map.len(), 2);

        assert!(grant_rate_forget(&mut map, "bot:S1"), "销毁必须真的删掉条目");
        assert_eq!(map.len(), 1);
        assert!(!map.contains_key("bot:S1"), "该 label 的条目必须消失");
        // 已销毁的 label 再次取券视为新窗口（计数从零开始）
        assert!(grant_rate_check(&mut map, "bot:S1", 1_010).is_ok());
        // 不存在的 label：forget 返回 false，不 panic
        assert!(!grant_rate_forget(&mut map, "nope"));
    }

    /// (A) 的返回形状必须是**可辨识联合**（裁定三十三 一）：成功分支字段齐、失败分支只有 error。
    #[test]
    fn grant_reply_shape_is_discriminated_union() {
        let ok = serde_json::to_string(&GrantReply::Ok(GrantReplyOk {
            ok: true,
            grant: "a.b".to_string(),
            exp_ms: 60_000,
        }))
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&ok).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["grant"], serde_json::json!("a.b"));
        assert_eq!(v["expMs"], serde_json::json!(60000));
        assert!(v.get("error").is_none(), "成功分支不得出现 error 字段");

        let err = serde_json::to_string(&GrantReply::Err(GrantReplyErr {
            ok: false,
            error: "no-config",
        }))
        .unwrap();
        let v2: serde_json::Value = serde_json::from_str(&err).unwrap();
        assert_eq!(v2["ok"], serde_json::json!(false));
        assert_eq!(v2["error"], serde_json::json!("no-config"));
        assert!(v2.get("grant").is_none(), "失败分支不得出现 grant 字段（禁可选字段形态）");
    }

    /// (A)：建窗时**不再**烤静态券；注入的是取券闭包（页面每连接现取）。
    #[test]
    fn build_uses_request_closure_not_static_grant() {
        let script = grant_request_closure_script();
        assert!(script.contains("__studioRequestGrant"), "必须注入取券闭包");
        assert!(script.contains("studio_request_grant"), "闭包应调用该命令");
        // 关键：不得再注入静态 __studioGrant（那正是「60s 后必死」的成因）
        assert!(
            !script.contains("__studioGrant"),
            "不得在建窗时注入静态券（P0 卡 (A) 已去掉）"
        );
    }

    // ── C 卡（MCP 独立原生窗口）：导航白名单 / 注入脚本 / 三种拒绝 ──────────────

    /// 装置自检：先证明这组夹具真的同时踩到了 allow 与 deny 两条分支。
    /// 没有这条，下面几条断言可能因为「夹具全落在同一侧」而静默失去意义。
    #[test]
    fn mcp_settings_nav_fixture_exercises_both_branches() {
        let allowed = Url::parse("http://127.0.0.1:8760/mcp-settings").unwrap();
        let denied = Url::parse("https://evil.example.com/mcp-settings").unwrap();
        assert!(
            mcp_settings_navigation_allowed(&allowed, 8760),
            "装置自检：allow 侧夹具必须真的被放行，否则 deny 断言是在空跑"
        );
        assert!(
            !mcp_settings_navigation_allowed(&denied, 8760),
            "装置自检：deny 侧夹具必须真的被拒，否则 allow 断言是在空跑"
        );
    }

    #[test]
    fn mcp_settings_nav_allows_own_loopback_page_only() {
        let port = 8760;
        for ok in [
            "http://127.0.0.1:8760/mcp-settings",
            "http://127.0.0.1:8760/mcp-settings?tab=servers",
            "http://localhost:8760/mcp-settings/index.html",
        ] {
            let u = Url::parse(ok).unwrap();
            assert!(mcp_settings_navigation_allowed(&u, port), "应放行：{}", ok);
        }
    }

    #[test]
    fn mcp_settings_nav_denies_remote_and_foreign_paths() {
        let port = 8760;
        let denied = [
            // ① 远端主机（本卡最核心的一条：导航过去 = 那个页面继承宿主 token）
            "https://evil.example.com/mcp-settings",
            "http://evil.example.com/mcp-settings",
            // ② 非回环但「长得像本机」的地址
            "http://0.0.0.0:8760/mcp-settings",
            "http://192.168.2.200:8760/mcp-settings",
            // ③ 端口不对（别的本机服务）
            "http://127.0.0.1:8080/mcp-settings",
            // ④ 路径越界（该窗只准停在自己的页面上）
            "http://127.0.0.1:8760/agent",
            "http://127.0.0.1:8760/v1/mcp/servers",
            // ⑤ 非 http
            "file:///C:/Windows/System32/drivers/etc/hosts",
        ];
        for bad in denied {
            let u = Url::parse(bad).unwrap();
            assert!(
                !mcp_settings_navigation_allowed(&u, port),
                "必须拒绝：{}",
                bad
            );
        }
    }

    #[test]
    fn mcp_settings_nav_denied_log_omits_query_and_userinfo() {
        let u = Url::parse("https://evil.example.com:8443/mcp-settings?token=SEKRET#frag").unwrap();
        let line = mcp_settings_nav_denied_line(&u);
        // 可 grep：前缀 + level
        assert!(line.starts_with("[studio] level=warn"), "日志行前缀必须可 grep：{}", line);
        assert!(line.contains("mcp-settings navigation denied"), "{}", line);
        assert!(line.contains("host=evil.example.com"), "{}", line);
        // 不泄漏：query / fragment / userinfo 一个都不许进日志
        assert!(!line.contains("SEKRET"), "query 不得进日志：{}", line);
        assert!(!line.contains("frag"), "fragment 不得进日志：{}", line);
        let with_auth = Url::parse("http://user:pw@127.0.0.1:1/mcp-settings").unwrap();
        let line2 = mcp_settings_nav_denied_line(&with_auth);
        assert!(!line2.contains("pw"), "userinfo 不得进日志：{}", line2);
    }

    #[test]
    fn mcp_settings_init_script_injects_token_and_single_closure() {
        let script = mcp_settings_init_script("tok-123", "http://127.0.0.1:8760");
        assert!(script.contains("__STUDIO_TOKEN__"), "必须注入 token");
        assert!(script.contains("tok-123"), "token 值必须落进脚本");
        assert!(script.contains("__studioOpenMcpSettings"), "必须暴露打开闭包");
        assert!(
            script.contains("studio_open_mcp_settings"),
            "闭包必须调该 command"
        );
        // 关键（裁定四十七 三）：捕获后**删除裸 invoke** —— 不删的话
        // 「远端页面拿不到裸 invoke」这句就是假的（页面自己就能 invoke 任意命令）。
        assert!(
            script.contains("delete window.__TAURI_INTERNALS__"),
            "必须删除裸 __TAURI_INTERNALS__，否则页面仍可自行 invoke 任意 command"
        );
        assert!(
            script.find("var internals = window.__TAURI_INTERNALS__").unwrap()
                < script.find("delete window.__TAURI_INTERNALS__").unwrap(),
            "删除必须发生在捕获之后（顺序反了就把闭包自己也废了）"
        );
    }

    #[test]
    fn mcp_settings_init_script_escapes_hostile_token() {
        // token 里出现引号/换行时，脚本必须仍是合法 JS 字面量（JSON 转义）。
        let script = mcp_settings_init_script("a\"b\nc", "http://127.0.0.1:8760");
        assert!(script.contains(r#""a\"b\nc""#), "token 必须按 JSON 转义：{}", script);
    }
    /// P0 卡 (B)：**配置目录唯一入口** —— 装版走 `<app_data_dir>/config`（与批 N+1
    /// 注入给宿主的 `STUDIO_CONFIG_DIR` 同源），dev 走 `~/.config/deepseek-studio`。
    ///
    /// 这条是「全新安装页面通道永久死」那条**推断风险面**的守门断言：一旦有人把
    /// `load_host_grant_script` 改回硬编码 `~/.config`，装版就读不到宿主写的 config，
    /// 本用例会红（装版分支必须等于 data_dir/config）。
    #[test]
    fn config_dir_is_single_source_for_installed_and_dev() {
        let data = std::path::PathBuf::from("X:\\appdata\\com.deepseek.studio");
        // 装版：<app_data_dir>/config
        assert_eq!(
            resolve_config_dir(true, Some(&data)),
            data.join("config"),
            "装版必须与宿主 STUDIO_CONFIG_DIR 同源（<app_data_dir>/config）"
        );
        // 装版但拿不到 app_data_dir：回落历史路径（不 panic、不造目录）
        let fallback = resolve_config_dir(true, None);
        assert!(fallback.ends_with(std::path::Path::new(".config").join("deepseek-studio")));
        // dev：永远是历史路径，**不受 app_data_dir 影响**
        let dev = resolve_config_dir(false, Some(&data));
        assert!(
            dev.ends_with(std::path::Path::new(".config").join("deepseek-studio")),
            "dev 形态必须保持旧落点，实际得到 {:?}",
            dev
        );
    }

    /// P0 卡 (C)：`load_host_grant_script` 的四条失败分支**不许静默** ——
    /// 每条都要在日志里留下可 grep 的一行（首启竞态就是 `no-config-file` 那支）。
    #[test]
    fn grant_script_logs_each_failure_branch() {
        let tmp = fresh_tmp("grant-branches");
        let log_path = tmp.join("studio-main-test.log");
        set_sidecar_log_path(Some(log_path.clone()));
        let read_log = || std::fs::read_to_string(&log_path).unwrap_or_default();

        // ① no-config-file（首启竞态：建窗时 config.json 还没写出来）
        let missing = tmp.join("nope").join("config.json");
        assert!(load_host_grant_script_with(&missing, "main").is_empty());
        assert!(read_log().contains("grant: no-config-file aud=main"), "{}", read_log());

        // ② parse-failed
        let broken = tmp.join("broken.json");
        std::fs::write(&broken, "{not json").unwrap();
        assert!(load_host_grant_script_with(&broken, "main").is_empty());
        assert!(read_log().contains("grant: parse-failed aud=main"), "{}", read_log());

        // ③ empty-secret
        let no_secret = tmp.join("nosecret.json");
        std::fs::write(&no_secret, r#"{"token":"t","secret":""}"#).unwrap();
        assert!(load_host_grant_script_with(&no_secret, "main").is_empty());
        assert!(read_log().contains("grant: empty-secret aud=main"), "{}", read_log());

        // ④ ok：有 secret → 真的签出券，且日志写 ok
        let good = tmp.join("good.json");
        std::fs::write(&good, r#"{"token":"t","secret":"s3cr3t-value"}"#).unwrap();
        let script = load_host_grant_script_with(&good, "main");
        assert!(script.contains("window.__studioGrant"), "应生成注入脚本，实际 {:?}", script);
        assert!(read_log().contains("grant: ok aud=main"), "{}", read_log());

        set_sidecar_log_path(None);
    }
    fn window_state_path_dev_falls_back_to_config_dir() {
        let fallback = std::path::PathBuf::from("X:\\roaming");
        // 无注入 / 空串 / 纯空白：一律回落（空白 env 视为未设，与 Node 侧 resolveConfigDir 同口径）
        for env_val in [None, Some(""), Some("   ")] {
            let got = window_state_path_with(env_val, Some(&fallback));
            assert_eq!(
                got,
                fallback.join("deepseek-studio").join("window-state.json"),
                "dev 形态必须保持旧落点（env_val={:?}）",
                env_val
            );
        }
    }

    /// 可观测性（卡片 D 条）：注入的 env 名与值必须能被 Rust 侧描述出来 ——
    /// `spawn_child` 把这一行写进 `sidecar-<ms>.log`，装版真机上「注入了什么」才可核。
    #[test]
    fn host_entry_describe_reports_injected_envs() {
        let tmp = fresh_tmp("n1-describe");
        let res = tmp.join("res");
        make_resource_root(&res, true);
        let data = tmp.join("appdata");
        std::fs::create_dir_all(&data).expect("appdata");

        let entry = resolve_host_entry_with_data_dir(
            true,
            Some(res.as_path()),
            Some(data.as_path()),
            Some(data.as_path()),
        );
        let text = entry.describe();
        assert!(text.contains("entry=bundled"), "{text}");
        assert!(text.contains("STUDIO_DISTRIBUTION=installed"), "{text}");
        assert!(text.contains("STUDIO_CONFIG_DIR=Some("), "{text}");
        assert!(text.contains("STUDIO_LOG_DIR=Some("), "{text}");
        // dev 侧描述必须显式写两个 None（而不是省略），否则真机上分不清「没注入」和「没打印」
        match resolve_host_entry_with(false, None, None) {
            tsx @ sidecar::HostEntry::Tsx { .. } => {
                let d = tsx.describe();
                assert!(d.contains("STUDIO_DISTRIBUTION=dev"), "{d}");
                assert!(d.contains("STUDIO_CONFIG_DIR=None"), "{d}");
                assert!(d.contains("STUDIO_LOG_DIR=None"), "{d}");
            }
            _ => panic!("dev 无 project_root 时应回退 tsx"),
        }
    }

    /// TD-02 关键：HMAC-SHA256 自实现必须与标准一致（否则 Rust 签的 grant，host(ts)
    /// 用 Web Crypto verifyRaw 验不过）。用 RFC 4231 Test Case 2 向量锁死。
    #[test]
    fn td02_hmac_sha256_rfc4231_case2() {
        // key = "Jefe", data = "what do ya want for nothing?"
        // 期望 HMAC-SHA256 = 5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843
        let out = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let hex: String = out.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// TD-02：签出的 grant 结构正确（payload.hmac 两段、claims 字段齐全、exp=iat+ttl）。
    #[test]
    fn td02_issue_bootstrap_grant_shape() {
        let g = issue_bootstrap_grant_rs("test-secret", "main", 60_000).expect("grant");
        let parts: Vec<&str> = g.split('.').collect();
        assert_eq!(parts.len(), 2, "grant 应为 payload.sig 两段");
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[0])
            .expect("payload b64");
        let json = String::from_utf8(payload).expect("utf8");
        let v: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(v["iss"], "deepseek-studio-host");
        assert_eq!(v["aud"], "main");
        assert_eq!(v["scope"], "ws-connect");
        assert_eq!(v["exp"].as_u64().unwrap() - v["iat"].as_u64().unwrap(), 60_000);
        assert!(!v["jti"].as_str().unwrap().is_empty());
    }

    /// TD-02 负控核心：注入脚本内容**不得含 config.token 原值**（用 grant 替代）。
    /// 这里直接验证 load_host_grant_script 产出的全局变量名是 __studioGrant，
    /// 且函数不存在把 token 写进 window.__studioHostToken 的路径。
    #[test]
    fn td02_script_uses_grant_not_token() {
        let g = issue_bootstrap_grant_rs("s3cr3t", "main", 1000).unwrap();
        // 模拟注入串
        let script = format!("window.__studioGrant = {};\n", serde_json::to_string(&g).unwrap());
        assert!(script.contains("__studioGrant"));
        assert!(!script.contains("__studioHostToken"), "不得再注入 __studioHostToken");
        // 密钥本身不得出现在注入串里
        assert!(!script.contains("s3cr3t"), "不得把 secret 注入页面");
    }

    fn entry(bot_id: &str, data_dir: Option<&str>) -> BotWindowConfig {
        BotWindowConfig {
            bot_id: bot_id.to_string(),
            visible: true,
            data_dir: data_dir.map(|s| s.to_string()),
        }
    }

    fn created(plans: &[BotWindowPlan]) -> Vec<(&str, String)> {
        plans
            .iter()
            .filter_map(|p| match p {
                BotWindowPlan::Create {
                    bot_id, data_dir, ..
                } => Some((bot_id.as_str(), normalize_for_compare(data_dir))),
                _ => None,
            })
            .collect()
    }

    fn skip_reasons(plans: &[BotWindowPlan]) -> Vec<String> {
        plans
            .iter()
            .filter_map(|p| match p {
                BotWindowPlan::Skip { reason, .. } => Some(reason.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn distinct_profiles_all_create() {
        let plans = plan_bot_windows(
            &[
                entry("S1", Some("profiles/S1")),
                entry("S2", Some("profiles/S2")),
            ],
            &[],
        );
        assert_eq!(created(&plans).len(), 2);
        assert!(skip_reasons(&plans).is_empty());
    }

    #[test]
    fn missing_datadir_derives_isolated_profile_not_main() {
        // 回归：旧实现 dataDir 缺失 → 静默共享主 profile（同账号双窗口）。
        // 现在必须派生 profiles/<botId>，且与主 profile 不同。
        let main =
            std::path::PathBuf::from("C:/Users/x/AppData/Local/com.deepseek.studio/EBWebView");
        let plans = plan_bot_windows(&[entry("S1", None)], &[main.clone()]);
        let c = created(&plans);
        assert_eq!(c.len(), 1, "missing dataDir must still create a window");
        assert_ne!(c[0].1, normalize_for_compare(&main));
        assert!(c[0].1.ends_with("/profiles/s1"), "got {}", c[0].1);
    }

    #[test]
    fn two_entries_same_profile_second_is_skipped() {
        // 同账号双窗口 = 必封，第二个必须 fail-closed 跳过。
        let plans = plan_bot_windows(
            &[
                entry("S1", Some("profiles/shared")),
                entry("S2", Some("profiles/shared")),
            ],
            &[],
        );
        assert_eq!(created(&plans).len(), 1);
        assert_eq!(skip_reasons(&plans).len(), 1);
        assert!(skip_reasons(&plans)[0].contains("already used"));
    }

    #[test]
    fn profile_colliding_with_main_window_is_skipped() {
        let main =
            std::path::PathBuf::from("C:/Users/x/AppData/Local/com.deepseek.studio/EBWebView");
        let plans = plan_bot_windows(
            &[entry(
                "S1",
                Some("C:/Users/x/AppData/Local/com.deepseek.studio/EBWebView"),
            )],
            &[main],
        );
        assert!(created(&plans).is_empty());
        assert_eq!(skip_reasons(&plans).len(), 1);
    }

    #[test]
    fn profile_compare_is_case_insensitive_on_windows() {
        let keys = [
            normalize_for_compare(std::path::Path::new("C:/Profiles/S1")),
            normalize_for_compare(std::path::Path::new("c:/profiles/s1/")),
        ];
        assert_eq!(keys[0], keys[1]);
    }

    #[test]
    fn duplicate_label_skipped_and_empty_bot_id_skipped() {
        // "a/b" 与 "ab" 经 sanitize_window_label 后同为 "ab" → 第二条目必须跳过（否则
        // Tauri 拒绝创建 / 标签冲突）。空 botId 同样跳过。
        let plans = plan_bot_windows(
            &[
                entry("ab", Some("profiles/ab")),
                entry("a/b", Some("profiles/slash")),
                entry("  ", Some("profiles/x")),
            ],
            &[],
        );
        assert_eq!(created(&plans).len(), 1);
        assert_eq!(skip_reasons(&plans).len(), 2);
    }

    // ── TD-04 补缺：项目根判定（package.json + src-tauri/ 缺一不可）────────

    fn tmp_base(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "dsh-project-root-{}-{}",
            std::process::id(),
            tag
        ))
    }

    /// PM 规格：exe 在 home 下、祖先有**杂散** package.json 时，**release** 必须取 app_data_dir。
    #[test]
    fn release_uses_app_data_even_when_home_has_stray_package_json() {
        let base = tmp_base("stray");
        let home = base.join("home");
        let exe_dir = home.join("AppData").join("Local").join("DeepSeek++ Studio");
        std::fs::create_dir_all(&exe_dir).unwrap();
        // home 下有一份**不相干**的 package.json（真实文件），且没有 src-tauri/
        std::fs::write(home.join("package.json"), "{}").unwrap();
        let app_data = base.join("appdata");

        // release：禁用向上搜索 → 必须拿 app_data_dir
        assert_eq!(
            resolve_project_root(&exe_dir, Some(app_data.clone()), false),
            Some(app_data.clone())
        );
        // debug：允许向上搜索，但缺 src-tauri/ → 仍不能把 home 当仓库根
        assert_eq!(
            resolve_project_root(&exe_dir, Some(app_data.clone()), true),
            Some(app_data.clone())
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// debug 构建：真正的仓库根（package.json + src-tauri/）要能认出来；
    /// release 构建对同一个 exe 位置**不许**认仓库根。
    #[test]
    fn debug_accepts_real_repo_root_but_release_does_not() {
        let base = tmp_base("repo");
        let repo = base.join("dev");
        let exe_dir = repo.join("src-tauri").join("target").join("debug");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::write(repo.join("package.json"), "{}").unwrap();
        let app_data = base.join("appdata");

        assert_eq!(
            resolve_project_root(&exe_dir, Some(app_data.clone()), true),
            Some(repo.clone())
        );
        assert_eq!(
            resolve_project_root(&exe_dir, Some(app_data.clone()), false),
            Some(app_data)
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// 负控：**只看 package.json 的旧判定**会把 home 认成仓库根 —— 这就是 20261103
    /// 那条 `project_root = C:\Users\<user>` 的成因；严格判定不会。
    ///
    /// 20261105 去标识化时发现原实现直接写死 `Path::new("C:/Users/<本机用户名>")`：
    /// 它**只有在「开发机 home 恰好有一份野生 package.json」时才成立**（本机正是这形态；
    /// 换台机器/换用户名这条负控就恒红，而 gate 不跑 cargo test，所以一直没暴露）。
    /// 改为临时目录夹具自带野生 package.json：**断言与语义一字不变**，但跨机成立，
    /// 公开仓也不再出现个人用户名。
    #[test]
    fn naive_package_json_only_would_misjudge_home_as_repo_root() {
        // 「home」形态：只有 package.json、没有 src-tauri/（安装版向上找时撞见的正是它）
        let base = tmp_base("naive-home");
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("package.json"), "{}").unwrap();

        let naive = find_project_root_with(&home, |d| d.join("package.json").is_file());
        assert_eq!(naive, Some(home.clone()));
        let strict = find_project_root_with(&home, |d| {
            d.join("package.json").is_file() && d.join("src-tauri").is_dir()
        });
        assert_eq!(strict, None);
        std::fs::remove_dir_all(&base).ok();
    }
}


