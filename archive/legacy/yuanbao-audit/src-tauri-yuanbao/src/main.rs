#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri 壳入口：解析 --url → 拉起 Node sidecar → 打开窗口 → 退出回收。
//! 控制 API 由 sidecar 提供（127.0.0.1:8761），壳本身不持有任何凭据。

mod sidecar;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use sidecar::{SidecarConfig, SidecarHandle};

pub const DEFAULT_PAGE_URL: &str = sidecar::DEFAULT_URL;

/// 解析窗口 URL：`--url X` / `--url=X` > 环境变量 TAOBAO_AUDIT_URL > 默认聊天页。
/// 仅放行 http/https（fail-closed：拒绝 file:/javascript: 等危险 scheme）。
pub fn resolve_page_url(args: &[String], lookup: impl Fn(&str) -> Option<String>) -> Result<Url, String> {
    let raw = match flag_value(args, "--url") {
        Some(v) => Some(v),
        None => lookup("TAOBAO_AUDIT_URL").filter(|s| !s.trim().is_empty()),
    };
    let candidate = raw.unwrap_or_else(|| DEFAULT_PAGE_URL.to_string());
    let trimmed = candidate.trim();
    let url = Url::parse(trimmed).map_err(|e| format!("非法 URL ({trimmed}): {e}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!("不允许的 scheme: {other}（仅 http/https）")),
    }
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    for (i, arg) in args.iter().enumerate() {
        if let Some(rest) = arg.strip_prefix(name) {
            if let Some(v) = rest.strip_prefix('=') {
                return Some(v.to_string());
            }
        }
        if arg == name {
            return args.get(i + 1).cloned();
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let page_url = match resolve_page_url(&args, |k| std::env::var(k).ok()) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[taobao] 参数错误：{e}");
            std::process::exit(2);
        }
    };

    let sidecar_cfg = SidecarConfig::from_env();
    let sidecar_slot: Arc<Mutex<Option<SidecarHandle>>> = Arc::new(Mutex::new(None));

    let app = tauri::Builder::default()
        .setup({
            let slot = Arc::clone(&sidecar_slot);
            let cfg = sidecar_cfg.clone();
            move |app| {
                // sidecar 起不来 → 只告警不退出（fail-open）：页面仍可正常使用，控制 API 不可用。
                match sidecar::spawn(&cfg) {
                    Ok(handle) => {
                        let ready = sidecar::wait_until_listening(&cfg.host, cfg.port, Duration::from_secs(30));
                        if !ready {
                            eprintln!(
                                "[taobao] sidecar 未在 30s 内就绪（{}:{}），窗口继续打开，控制 API 不可用",
                                cfg.host, cfg.port
                            );
                        }
                        *slot.lock().expect("sidecar slot poisoned") = Some(handle);
                    }
                    Err(e) => eprintln!("[taobao] sidecar 拉起失败：{e}（窗口继续打开）"),
                }

                let _window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(page_url.clone()))
                    .title("DeepSeek Studio")
                    .inner_size(1280.0, 860.0)
                    .build()?;
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri app");

    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            if let Ok(mut slot) = sidecar_slot.lock() {
                if let Some(mut handle) = slot.take() {
                    handle.shutdown();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_page_url_when_no_args() {
        let url = resolve_page_url(&[], |_| None).expect("default ok");
        assert_eq!(url.as_str(), "https://chat.deepseek.com/");
    }

    #[test]
    fn url_flag_wins_over_env() {
        let args = vec!["--url".to_string(), "https://example.com/x".to_string()];
        let url = resolve_page_url(&args, |_| Some("https://env.example/".to_string())).expect("flag ok");
        assert_eq!(url.as_str(), "https://example.com/x");
    }

    #[test]
    fn url_flag_equals_form() {
        let args = vec!["--url=https://example.com:8443/a?b=1".to_string()];
        let url = resolve_page_url(&args, |_| None).expect("equals form ok");
        assert_eq!(url.as_str(), "https://example.com:8443/a?b=1");
    }

    #[test]
    fn env_fallback_when_no_flag() {
        let url = resolve_page_url(&[], |k| {
            if k == "TAOBAO_AUDIT_URL" {
                Some("http://127.0.0.1:5173/".to_string())
            } else {
                None
            }
        })
        .expect("env ok");
        assert_eq!(url.as_str(), "http://127.0.0.1:5173/");
    }

    #[test]
    fn rejects_non_http_scheme_and_garbage() {
        assert!(resolve_page_url(&["--url".to_string(), "javascript:alert(1)".to_string()], |_| None).is_err());
        assert!(resolve_page_url(&["--url".to_string(), "file:///etc/passwd".to_string()], |_| None).is_err());
        assert!(resolve_page_url(&["--url".to_string(), "not a url".to_string()], |_| None).is_err());
    }

    #[test]
    fn flag_value_handles_missing_value() {
        assert_eq!(flag_value(&["--url".to_string()], "--url"), None);
    }
}
