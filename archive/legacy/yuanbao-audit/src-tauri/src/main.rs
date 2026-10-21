// 元宝审计桌面壳 · 入口
//   - 主窗口加载真实 yuanbao.tencent.com（External URL）
//   - initialization_script 注入 dist/desktop-entry.js（自启动监控 + 状态浮层）
//   - 无 sidecar、无托盘：监控逻辑全在 WebView 内跑，登录态由 WebView2 持久化

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};
use url::Url;

const YUANBAO_URL: &str = "https://yuanbao.tencent.com/";

/// 伪装成 Android 手机 Chrome（试探腾讯是否给移动端不同版本）
const DESKTOP_CHROME_UA: &str = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

/// 运行时读取注入脚本（dist/desktop-entry.js）。
/// 搜索顺序：当前目录 → 项目根 → exe 同级。
fn load_init_script() -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    candidates.push(std::path::PathBuf::from("dist/desktop-entry.js"));
    candidates.push(std::path::PathBuf::from("src-tauri/dist/desktop-entry.js"));

    // 项目根（exe_dir 向上最多 3 层）
    if let Some(root) = exe_dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
        candidates.push(root.join("dist/desktop-entry.js"));
    }
    candidates.push(exe_dir.join("dist/desktop-entry.js"));

    for candidate in &candidates {
        if let Ok(s) = std::fs::read_to_string(candidate) {
            eprintln!("[yuanbao-audit] inject loaded from: {:?}", candidate);
            return s;
        }
    }
    eprintln!("[yuanbao-audit] WARN: desktop-entry.js not found, running without injection");
    String::new()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let win = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(Url::parse(YUANBAO_URL).expect("invalid url")),
            )
            .title("元宝审计")
            .inner_size(412.0, 915.0)
            .min_inner_size(360.0, 640.0)
            .user_agent(DESKTOP_CHROME_UA)
            .initialization_script(&load_init_script())
            .build()
            .expect("failed to create window");
            let _ = &win;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running yuanbao-audit");
}
