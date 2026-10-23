// 入口：v0.12 应用外壳。
//   - 主窗口加载真实 chat.deepseek.com（External URL），由 WebView 渲染真实站点。
//   - initialization_script 注入编译后的 src/desktop/entry.js。
//   - v0.12 Phase 1：受监管 sidecar 进程管理层。
//   - v0.12 Phase 3：系统托盘 + 窗口状态记忆。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// 运行时读取注入脚本（而非 include_str! 编译时嵌入）。
/// 搜索顺序：当前工作目录 → 相对于 exe 目录（向上找项目根）→ exe 同级。
fn load_init_script() -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
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
    WebviewWindowBuilder::new(&app, "workbench", WebviewUrl::External(url))
        .title("DeepSeek++ Studio · 工作台")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 720.0)
        .build()
        .map_err(|e| format!("failed to create workbench window: {}", e))?;
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
                create_bot_window(&app, &ctx, &label, &bot_id, visible, data_dir)?;
            }
        }
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_workbench,
            focus_main_window,
            open_bot_window
        ])
        // v0.30 单实例锁：第二个 deepseek-studio.exe 进程不再创建窗口，
        // 而是聚焦到已有主窗口（根治多实例 × N bot 窗口 = 窗口爆炸）。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
            // v0.12：受监管 sidecar 启动
            if std::env::var("STUDIO_DISABLE_HOST").is_err() {
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                let project_root = exe_dir
                    .parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| std::path::PathBuf::from("E:/NAS/deepseek-studio"));
                eprintln!("[studio] project_root: {:?}", project_root);

                let (handle, event_rx) = sidecar::SidecarHandle::start(project_root);
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
                    load_init_script()
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
                load_init_script()
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
                eprintln!("[studio] CloseRequested for window: {}", label);
                // v0.24：bot 窗口直接放行原生关闭——不保存几何（避免污染主窗口状态）、
                // 也不关闭 sidecar（它是全应用共享的常驻宿主进程）。仅主窗口走下方优雅关闭。
                if label != "main" {
                    eprintln!(
                        "[studio] bot window {:?} closed (state/sidecar untouched)",
                        label
                    );
                    return;
                }
                api.prevent_close();

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
                    if let Some(handle) = app_handle.try_state::<sidecar::SidecarHandle>() {
                        handle.shutdown();
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                    if let Some(win) = app_handle.get_webview_window(&label) {
                        let _ = win.destroy();
                    }
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
}
