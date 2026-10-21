//! Node sidecar 生命周期：解析启动命令 → spawn → TCP 就绪探活 → 退出回收。
//!
//! 与 api-taobao 侧共用同一套环境变量（TAOBAO_AUDIT_HOST/PORT），避免两边配置漂移。

use std::env;
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 8761;
pub const DEFAULT_URL: &str = "https://chat.deepseek.com";
const DEFAULT_PROGRAM: &str = "node";
const DEFAULT_ARG: &str = "dist/api-taobao/main.js";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarConfig {
    pub program: String,
    pub args: Vec<String>,
    pub host: String,
    pub port: u16,
}

impl Default for SidecarConfig {
    fn default() -> Self {
        Self {
            program: DEFAULT_PROGRAM.to_string(),
            args: vec![DEFAULT_ARG.to_string()],
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
        }
    }
}

impl SidecarConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|k| env::var(k).ok())
    }

    /// 纯解析逻辑（便于单测注入假环境）：
    ///   TAOBAO_AUDIT_SIDECAR_CMD = "node --expose-gc dist/api-taobao/main.js"（空白切分）
    ///   TAOBAO_AUDIT_HOST / TAOBAO_AUDIT_PORT 覆盖探活地址
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let mut cfg = Self::default();
        if let Some(cmd) = lookup("TAOBAO_AUDIT_SIDECAR_CMD") {
            let parts: Vec<String> = cmd.split_whitespace().map(|s| s.to_string()).collect();
            if let Some((program, args)) = parts.split_first() {
                cfg.program = program.clone();
                cfg.args = args.to_vec();
            }
        }
        if let Some(host) = lookup("TAOBAO_AUDIT_HOST") {
            let host = host.trim();
            if !host.is_empty() {
                cfg.host = host.to_string();
            }
        }
        if let Some(port) = lookup("TAOBAO_AUDIT_PORT") {
            if let Ok(p) = port.trim().parse::<u16>() {
                if p != 0 {
                    cfg.port = p;
                }
            }
        }
        cfg
    }
}

/// 构造子进程命令（单测用 `Command::get_program/get_args/get_envs` 断言）。
pub fn build_command(cfg: &SidecarConfig) -> Command {
    let mut cmd = Command::new(&cfg.program);
    cmd.args(&cfg.args)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    cmd.env("TAOBAO_AUDIT_HOST", &cfg.host);
    cmd.env("TAOBAO_AUDIT_PORT", cfg.port.to_string());
    cmd
}

pub struct SidecarHandle {
    child: Child,
}

impl SidecarHandle {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// 回收子进程：kill + wait，幂等（进程已退出则忽略错误）。
    pub fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn spawn(cfg: &SidecarConfig) -> std::io::Result<SidecarHandle> {
    let child = build_command(cfg).spawn()?;
    Ok(SidecarHandle { child })
}

/// 单次 TCP 探活：端口能连上即视为 HTTP server 已监听（不额外引 HTTP 客户端依赖）。
pub fn probe(host: &str, port: u16) -> bool {
    let timeout = Duration::from_millis(250);
    if let Ok(addr) = format!("{}:{}", host, port).parse::<SocketAddr>() {
        return TcpStream::connect_timeout(&addr, timeout).is_ok();
    }
    TcpStream::connect((host, port)).is_ok()
}

/// 等待就绪：每 200ms 探活一次直到超时。
pub fn wait_until_listening(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if probe(host, port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::net::TcpListener;

    #[test]
    fn config_defaults_match_contract() {
        let cfg = SidecarConfig::from_lookup(|_| None);
        assert_eq!(cfg, SidecarConfig::default());
        assert_eq!(cfg.program, "node");
        assert_eq!(cfg.args, vec!["dist/api-taobao/main.js".to_string()]);
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8761);
    }

    #[test]
    fn config_env_overrides_command_host_port() {
        let cfg = SidecarConfig::from_lookup(|k| match k {
            "TAOBAO_AUDIT_SIDECAR_CMD" => {
                Some("node --max-old-space-size=512 dist/api-taobao/main.js".to_string())
            }
            "TAOBAO_AUDIT_HOST" => Some("localhost".to_string()),
            "TAOBAO_AUDIT_PORT" => Some("9001".to_string()),
            _ => None,
        });
        assert_eq!(cfg.program, "node");
        assert_eq!(
            cfg.args,
            vec![
                "--max-old-space-size=512".to_string(),
                "dist/api-taobao/main.js".to_string()
            ]
        );
        assert_eq!(cfg.host, "localhost");
        assert_eq!(cfg.port, 9001);
    }

    #[test]
    fn config_ignores_blank_cmd_and_bad_port() {
        let cfg = SidecarConfig::from_lookup(|k| match k {
            "TAOBAO_AUDIT_SIDECAR_CMD" => Some("   ".to_string()),
            "TAOBAO_AUDIT_PORT" => Some("not-a-port".to_string()),
            "TAOBAO_AUDIT_HOST" => Some("".to_string()),
            _ => None,
        });
        assert_eq!(cfg, SidecarConfig::default());
    }

    #[test]
    fn build_command_sets_program_args_and_env() {
        let cfg = SidecarConfig {
            program: "node".to_string(),
            args: vec!["dist/api-taobao/main.js".to_string()],
            host: "127.0.0.1".to_string(),
            port: 9002,
        };
        let cmd = build_command(&cfg);
        assert_eq!(cmd.get_program(), OsStr::new("node"));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["dist/api-taobao/main.js".to_string()]);
        let envs: HashMap<String, String> = cmd
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
            .collect();
        assert_eq!(envs.get("TAOBAO_AUDIT_PORT").map(String::as_str), Some("9002"));
        assert_eq!(envs.get("TAOBAO_AUDIT_HOST").map(String::as_str), Some("127.0.0.1"));
    }

    #[test]
    fn probe_and_wait_detect_real_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe("127.0.0.1", port));
        assert!(wait_until_listening("127.0.0.1", port, Duration::from_millis(500)));
    }

    #[test]
    fn probe_false_and_wait_times_out_when_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!probe("127.0.0.1", port));
        assert!(!wait_until_listening("127.0.0.1", port, Duration::from_millis(300)));
    }
}
