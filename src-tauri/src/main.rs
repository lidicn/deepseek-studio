// 入口：v0.12 应用外壳。
//   - 主窗口加载真实 chat.deepseek.com（External URL），由 WebView 渲染真实站点。
//   - initialization_script 注入编译后的 src/desktop/entry.js。
//   - v0.12 Phase 1：受监管 sidecar 进程管理层。
//   - v0.12 Phase 3：系统托盘 + 窗口状态记忆。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

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
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
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
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return String::new(),
    };
    let cfg_path = home
        .join(".config")
        .join("deepseek-studio")
        .join("config.json");
    let s = match std::fs::read_to_string(&cfg_path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let cfg: StudioConfig = match serde_json::from_str(&s) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[studio] WARN: config.json parse failed: {}", e);
            return String::new();
        }
    };
    if cfg.token.is_empty() || cfg.chat_rooms.is_empty() {
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

/// QD-R2-01 / H-2b：把 config.json 里的 WS host token 注入 `window.__studioHostToken`。
///
/// 为什么独立成函数：load_studio_chat_config_script 在 chat_rooms 为空时整段 return 空串，
/// 但 bot 窗口（无聊天室配置）同样要连 /studio 工具通道——它们必须也拿到 token，
/// 否则注入页裸连 ws://127.0.0.1:8760/studio，服务端 upgrade 阶段就会 1008 拒连。
fn load_host_token_script() -> String {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return String::new(),
    };
    let cfg_path = home
        .join(".config")
        .join("deepseek-studio")
        .join("config.json");
    let s = match std::fs::read_to_string(&cfg_path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let cfg: StudioConfig = match serde_json::from_str(&s) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    if cfg.token.is_empty() {
        return String::new();
    }
    format!(
        "window.__studioHostToken = {};\n",
        serde_json::to_string(&cfg.token).unwrap()
    )
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
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("deepseek-studio")
        .join("bot-windows.json")
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
        base.join("deepseek-studio").join(trimmed)
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
            None => match dirs::config_dir()
                .map(|b| b.join("deepseek-studio").join("profiles").join(&bot_id))
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
fn workbench_url() -> String {
    let (host, port) = dirs::home_dir()
        .map(|h| {
            h.join(".config")
                .join("deepseek-studio")
                .join("config.json")
        })
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<StudioConfig>(&s).ok())
        .map(|c| {
            (
                c.host.unwrap_or_else(|| "127.0.0.1".to_string()),
                c.port.unwrap_or(8760),
            )
        })
        .unwrap_or_else(|| ("127.0.0.1".to_string(), 8760));
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

    // QD-R2-01：bot 窗口的注入页连 /studio 同样需要 host token——
    // 拼在 botId 声明之前，entry.ts 的 createHostClient 即可读到。
    if !ctx.disable_inject {
        let host_token_script = load_host_token_script();
        let with_bot = inject_with_bot_id(&ctx.base_script, bot_id);
        builder = builder.initialization_script(&format!("{}{}", host_token_script, with_bot));
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
/// 当成项目根（20261103 实测：`project_root` 落到 `C:\Users\lidicn`，
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

fn resolve_host_entry(
    resource_dir: Option<&std::path::Path>,
    project_root: Option<&std::path::Path>,
) -> sidecar::HostEntry {
    let has_ui = |root: &std::path::Path| {
        root.join("src").join("ui").join("agent.html").is_file()
    };

    // ── 开发构建：只认**仓库内**产物（`npm run build:host` 的输出）。
    //    刻意不认 resource_dir 下的同步副本（build:host 会往 target/debug/host 拷一份）：
    //    ① 副本可能是旧的，dev 应该跑仓库里最新的那份；
    //    ② 若认副本，「把 src-tauri/host/main.mjs 改名 → 应回退 tsx」这条 dev 回退验证
    //       就永远测不出来（总有副本兜着）。
    if cfg!(debug_assertions) {
        if let Some(root) = project_root {
            let script = root.join("src-tauri").join("host").join("main.mjs");
            if script.is_file() && has_ui(root) {
                return sidecar::HostEntry::Bundled {
                    script: strip_verbatim(&script),
                    resource_root: strip_verbatim(root),
                    // dev：工作目录 = 仓库根（logs/trace 落仓库 logs/trace，与开发态一致）
                    work_dir: strip_verbatim(root),
                };
            }
        }
        let root = project_root
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        eprintln!(
            "[studio] WARN: 未找到仓库内宿主单文件 <root>/src-tauri/host/main.mjs → 回退 tsx（仅开发可用，打包版必须带 host/main.mjs）"
        );
        return sidecar::HostEntry::Tsx { project_root: root };
    }

    // ── 打包版：只认 resource_dir。
    if let Some(res) = resource_dir {
        let script = res.join("host").join("main.mjs");
        if script.is_file() && has_ui(res) {
            return sidecar::HostEntry::Bundled {
                script: strip_verbatim(&script),
                resource_root: strip_verbatim(res),
                // release：工作目录 = 数据目录（app_data_dir），**不是安装目录**
                // （安装目录可能只读 → logs/trace 写不进去）。
                work_dir: project_root
                    .map(strip_verbatim)
                    .unwrap_or_else(|| strip_verbatim(res)),
            };
        }
        if script.is_file() {
            eprintln!(
                "[studio] WARN: 资源根 {:?} 下缺 src/ui/agent.html —— /agent 面板会 404（其余 API 可用）",
                res
            );
            return sidecar::HostEntry::Bundled {
                script: strip_verbatim(&script),
                resource_root: strip_verbatim(res),
                // release：工作目录 = 数据目录（app_data_dir），**不是安装目录**
                // （安装目录可能只读 → logs/trace 写不进去）。
                work_dir: project_root
                    .map(strip_verbatim)
                    .unwrap_or_else(|| strip_verbatim(res)),
            };
        }
    }
    eprintln!("[studio] 宿主入口缺失：<resource_dir>/host/main.mjs 不存在。");
    eprintln!("[studio] 这是打包错误（bundle.resources 漏了 host/main.mjs）→ 先 `npm run build:host` 再打包。");
    std::process::exit(sidecar::EXIT_HOST_MISSING);
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
            open_bot_window
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
            // v0.12：受监管 sidecar 启动
            if std::env::var("STUDIO_DISABLE_HOST").is_err() {
                // TD-04：node 必须先有 —— 打包版跑随包单文件、dev 回退 tsx，两者都要 node。
                // 找不到就用专用退出码，不进取监管线程的重试循环（那只会无限刷屏）。
                if let Err(why) = sidecar::probe_node() {
                    eprintln!("[studio] 宿主启动失败：找不到可用的 Node.js（{why}）");
                    eprintln!(
                        "[studio] 请安装 Node.js ≥24（https://nodejs.org/），或用 STUDIO_NODE 指定 node 可执行文件路径。"
                    );
                    std::process::exit(sidecar::EXIT_NODE_MISSING);
                }
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
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
                let host_entry =
                    resolve_host_entry(resource_dir.as_deref(), project_root.as_deref());
                match &host_entry {
                    sidecar::HostEntry::Bundled { script, resource_root, work_dir } => {
                        eprintln!("[studio] host entry: bundled {:?}", script);
                        eprintln!("[studio] STUDIO_RESOURCE_ROOT: {:?}", resource_root);
                        // 工作目录（可写）：宿主把 logs/trace 写在这里 → 必须是数据目录，不是安装目录
                        eprintln!("[studio] host work_dir: {:?}", work_dir);
                    }
                    sidecar::HostEntry::Tsx { project_root } => {
                        eprintln!("[studio] host entry: tsx (dev fallback) {:?}", project_root);
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
                // QD-R2-01：注入页连 /studio 工具通道也要带 token——单独一段常量，
                // 不依赖 chat_rooms 配置（无聊天室的纯工具窗口同样要鉴权）。
                let host_token_script = load_host_token_script();
                let init_script = format!(
                    "{}{}{}",
                    chat_config_script,
                    host_token_script,
                    load_init_script(resource_dir.as_deref())
                );
                main_builder = main_builder.initialization_script(&init_script);
            }

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
    /// 那条 `project_root = C:\Users\lidicn` 的成因；严格判定不会。
    #[test]
    fn naive_package_json_only_would_misjudge_home_as_repo_root() {
        let home = std::path::Path::new("C:/Users/lidicn");
        let naive = find_project_root_with(home, |d| d.join("package.json").is_file());
        assert_eq!(naive, Some(home.to_path_buf()));
        let strict = find_project_root_with(home, |d| {
            d.join("package.json").is_file() && d.join("src-tauri").is_dir()
        });
        assert_eq!(strict, None);
    }
}
