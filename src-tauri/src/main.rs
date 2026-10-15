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

    if let Some(root) = exe_dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
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
    let cfg_path = home.join(".config").join("deepseek-studio").join("config.json");
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
    format!(
        "window.__studioChatConfig = {};\n",
        payload
    )
}

fn bot_windows_path() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("deepseek-studio")
        .join("bot-windows.json")
}

fn load_bot_windows_config() -> BotWindowsConfig {
    let path = bot_windows_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<BotWindowsConfig>(&s) {
            eprintln!("[studio] bot windows config: {} entries", cfg.bots.len());
            return cfg;
        }
        eprintln!("[studio] WARN: bot-windows.json parse failed, using empty");
    }
    BotWindowsConfig::default()
}

/// 带 botId 的注入脚本：在原脚本最前面声明 window.__studioBotId，
/// 供 entry.ts 的 createHostClient 读取（缺省 = 'main'）。
fn inject_with_bot_id(base_script: &str, bot_id: &str) -> String {
    let declare = format!("window.__studioBotId = {};\n", serde_json::to_string(bot_id).unwrap());
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
    let path = if trimmed.starts_with('/') || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':') {
        std::path::PathBuf::from(trimmed)
    } else if trimmed == "~" || trimmed.starts_with("~/") {
        base.join(trimmed.trim_start_matches("~/"))
    } else {
        base.join("deepseek-studio").join(trimmed)
    };
    Some(path)
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
    if out.is_empty() { "bot".to_string() } else { out }
}

fn main() {
    tauri::Builder::default()
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
                let init_script = format!("{}{}", chat_config_script, load_init_script());
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

            // v0.24：按预配置创建 bot 窗口（每窗口独立登录态）。
            // 主窗口已建好；bot 窗口逐个容错创建——单个失败不影响主窗口，也不中断 setup。
            let base_script = if !disable_inject { load_init_script() } else { String::new() };
            for entry in load_bot_windows_config().bots {
                let bot_id = entry.bot_id.trim().to_string();
                if bot_id.is_empty() {
                    eprintln!("[studio] bot window skipped: empty botId");
                    continue;
                }
                let label = sanitize_window_label(&bot_id);
                // 标签必须唯一；重复条目跳过，避免 Tauri 拒绝/panic
                if app.get_webview_window(&label).is_some() {
                    eprintln!("[studio] bot window skipped: duplicate label {:?}", label);
                    continue;
                }
                let mut builder = WebviewWindowBuilder::new(
                    app,
                    &label,
                    WebviewUrl::External(Url::parse(CHAT_URL).expect("invalid chat url")),
                )
                .title(format!("DeepSeek++ Studio [{}]", bot_id))
                .visible(entry.visible)
                .inner_size(1280.0, 800.0);

                // 注入带 botId 的脚本（禁用注入时不注入）
                if !disable_inject {
                    let script = inject_with_bot_id(&base_script, &bot_id);
                    builder = builder.initialization_script(&script);
                }

                // profile 隔离：独立 WebView2 user data folder → Cookie/localStorage 不串号
                if let Some(dir) = entry.data_dir.as_ref().and_then(|d| resolve_data_dir(d)) {
                    let _ = std::fs::create_dir_all(&dir);
                    builder = builder.data_directory(dir);
                } else {
                    eprintln!(
                        "[studio] bot {:?} has no valid dataDir → shares main profile (cookies WILL cross)",
                        bot_id
                    );
                }

                match builder.build() {
                    Ok(_) => eprintln!("[studio] bot window created: label={:?} visible={}", label, entry.visible),
                    Err(e) => eprintln!("[studio] FAILED to create bot window {:?}: {:?}", label, e),
                }
            }

            // v0.12 Phase 3：系统托盘
            #[cfg(feature = "tray-icon")]
            {
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                let tray = TrayIconBuilder::with_id("main-tray")
                    .tooltip("DeepSeek++ Studio")
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
                    eprintln!("[studio] bot window {:?} closed (state/sidecar untouched)", label);
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
