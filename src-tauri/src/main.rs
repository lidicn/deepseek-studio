// 入口：v0.4 应用外壳。
//   - 主窗口加载真实 chat.deepseek.com（External URL），由 WebView 渲染真实站点。
//   - initialization_script 注入编译后的 src/desktop/entry.js（挂 window.__deepseekStudio、同域桥、宿主客户端）。
//   - M1：第二个窗口「agent」加载本地宿主的 /agent 智能体面板（宿主进程内置服务，端口 8756）。
//   - 可选：生产态由 STUDIO_SPAWN_HOST 环境变量触发，主进程拉起 Node 常驻宿主（端口 8756）。
//     开发态由 tauri.conf 的 beforeDevCommand（npm run start）负责启动宿主，避免重复拉起。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// 运行时读取注入脚本（而非 include_str! 编译时嵌入）。
/// 这样改 TS → build:inject → 重启 exe 即可，无需重链接 Rust（迭代从 ~8min 降到 ~10s）。
/// 开发态 cargo run 的 cwd 是 src-tauri/；也兼容从仓库根启动。
fn load_init_script() -> String {
    for candidate in ["inject/entry.js", "src-tauri/inject/entry.js"] {
        if let Ok(s) = std::fs::read_to_string(candidate) {
            return s;
        }
    }
    eprintln!("[studio] WARN: entry.js not found on disk, running without injection");
    String::new()
}

const CHAT_URL: &str = "https://chat.deepseek.com";
const AGENT_PANEL_URL: &str = "http://127.0.0.1:8756/agent";

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 生产态可选：拉起 Node 常驻宿主（默认关闭，开发态由 beforeDevCommand 启动）。
            if std::env::var("STUDIO_SPAWN_HOST").is_ok() {
                tauri::async_runtime::spawn(async {
                    let _ = std::process::Command::new("npm").args(["run", "start"]).spawn();
                });
            }

            // 临时开关：STUDIO_DISABLE_INJECT=1 时主窗口不挂注入脚本，用于在风控/登录
            // 异常时以"干净 WebView2"完成登录（cookie 持久化在 WebView2 profile），
            // 登完去掉该变量重启即恢复注入。
            let disable_inject = std::env::var("STUDIO_DISABLE_INJECT").is_ok();

            let mut main_builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(Url::parse(CHAT_URL).expect("invalid chat url")),
            )
            .title(if disable_inject { "DeepSeek++ Studio (NO-INJECT)" } else { "DeepSeek++ Studio" });

            if !disable_inject {
                main_builder = main_builder.initialization_script(&load_init_script());
            }

            let _win = main_builder.build().expect("failed to create window");

            // M1 智能体面板：加载宿主内置 /agent 页面（面板不注入 entry.js，
            // 它是宿主的 UI 而非聊天页运行时；宿主未就绪时页面会自动重连 WS）。
            let _agent = WebviewWindowBuilder::new(
                app,
                "agent",
                WebviewUrl::External(Url::parse(AGENT_PANEL_URL).expect("invalid agent panel url")),
            )
            .title("DeepSeek Studio · 智能体")
            .inner_size(920.0, 680.0)
            .min_inner_size(720.0, 520.0)
            .build()
            .expect("failed to create agent panel window");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running deepseek-studio");
}
