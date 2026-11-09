//! K1（2026-11-09，审批重设计 v1 阶段一）：**Studio 审批窗口**（独立 Tauri 窗口）基建。
//!
//! 设计稿：`docs/设计稿/20261109-审批重设计-v1.md` §3。
//!
//! ── 为什么必须是独立窗口 ─────────────────────────────────────────────────────
//! 旧审批面是注入 `chat.deepseek.com` 的 DOM（`src/ui/consent.ts`），而
//! `src/inject/main-world-interceptor.ts` 跑在**同一页的 main world** ⇒ agent 能改写/删除/
//! 伪造它（设计稿 D1）。独立 webview 不在 chat 的渲染树里，main-world 注入脚本进不去。
//!
//! **诚实边界（沿用设计稿 §3.3 末段）**：窗口内仍是 WebView，不是操作系统级原生 GUI。
//! 它的强度来自「独立 webview、无页面级注入」——比 MessageBox 弱一档、比页内 DOM 强很多。
//! 本模块**不宣称**「操作系统级不可伪造」。
//!
//! ── 通道（本卡最硬的一环）────────────────────────────────────────────────────
//! node 宿主（sidecar）与 Rust 主进程之间**没有 node→Rust 上行 RPC**。所以不走新通道，
//! 两个方向都交给已有的本机 HTTP：
//!
//! ```text
//! Rust 后台线程（200ms）── GET  /v1/consent/pending ──► node 宿主（8760）
//!   └ 有 pending ⇒ 开/复用窗口；无 pending ⇒ 关窗（destroy，不 hide）
//! 窗口内页面 ── GET /v1/consent/pending、POST /v1/consent/reply ──► node 宿主
//! ```
//!
//! Rust 只负责「有没有待审批」，**不碰决议内容**：决议由窗口内页面 POST 给宿主，
//! 由宿主侧做 nonce 一次性消费 + ownerId 绑定（K2）。这样 8760 仍是唯一信任边界，
//! Rust 侧无需理解审批语义。
//!
//! ── 与 MCP 设置窗口（`main.rs:1357`）的关系 ──────────────────────────────────
//! 同一套骨架：`WebviewWindowBuilder` + `initialization_script` 注入 + `on_navigation`
//! 白名单 + `inflight_begin/end` 单实例 + 建窗离开 IPC 回调。差别有三处，都在下面注释里：
//!   ① init script **只注入两个变量**，连 `invoke` 闭包都不暴露（该窗不需要任何 command）；
//!   ② 导航白名单是 `/consent` 段落匹配，不是简单前缀（挡 `/consentreports` 这类碰撞）；
//!   ③ 生命周期由后台轮询驱动（宿主说没请求就关窗），不是「用户点了按钮才留下」。

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::{
    grant_log, host_token_from_config, inflight_begin, inflight_end, p0_log, studio_host_port,
    SHUTTING_DOWN,
};

/// 窗口 label。运行时限用，不进任何窗口状态文件（`window-state.json` 只记主窗几何）。
pub const CONSENT_LABEL: &str = "consent";

/// 该窗**唯一**允许停留的路径段。页面与它的静态资源都落在这个段下。
pub const CONSENT_PATH: &str = "/consent";

/// 待审批查询端点（K2 提供）。
pub const CONSENT_PENDING_PATH: &str = "/v1/consent/pending";

/// 轮询间隔。设计稿写死 200ms：宿主挂起等待审批时，用户点到画面上线的体感上界
/// ≈ 一次轮询 + 一次渲染，200ms 已在「即时」区间内；再密就是白烧 CPU。
pub const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// 单次 HTTP 探测的预算。必须**远小于**宿主侧审批超时，否则轮询自己会把等待拉长。
pub const POLL_HTTP_TIMEOUT: Duration = Duration::from_millis(1500);

/// 响应体上界：这是个「有没有待审批」的状态查询，不该有大会话体。
/// 有上界才有下界——不设上界等于给对端一个把本线程读爆的机会。
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// 窗口 URL / 导航白名单
// ─────────────────────────────────────────────────────────────────────────────

/// 该窗的页面 URL：与工作台、MCP 设置窗**同源**（`studio_host_port()` 单点读取），只换路径。
pub fn consent_window_url(host: &str, port: u16) -> String {
    format!("http://{}:{}{}", host, port, CONSENT_PATH)
}

/// 回环判定。只认字面回环地址——`0.0.0.0` / 局域网 IP / 域名一律不算。
///
/// 与 `main.rs:is_loopback_host` 同判据，但那一个是主模块私有；本卡不为了复用去改它的可见性
/// （动别人模块的可见性 = 顺手重构）。两边判据都极短且各有单测钉住，重复优于跨模块耦合。
fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

/// `/consent` **段**匹配：`/consent`、`/consent/`、`/consent/xxx`、`/consent.js`、`/consent.css`。
///
/// ⚠️ 为什么不用 `path.starts_with("/consent")`：那会连 `/consentreports`、
/// `/consent-admin` 一并放行。这个窗里躺着**宿主全权 token**，白名单只许紧不许松。
fn is_consent_path(path: &str) -> bool {
    path == CONSENT_PATH
        || path == "/consent/"
        || path.starts_with("/consent/")
        || path.starts_with("/consent.")
}

/// 导航策略（**纯函数**，可单测）：只准停在「http + 回环 host + 本机端口 + `/consent` 段」。
///
/// 为什么必须是白名单而不是黑名单：init script 往这个窗注入了宿主全权 token，
/// 一旦被导航到远端页面，该页面就继承了 token ⇒ 宿主全权失守。除白名单外一律 false。
pub fn consent_navigation_allowed(target: &Url, port: u16) -> bool {
    if target.scheme() != "http" {
        return false;
    }
    let host = match target.host_str() {
        Some(h) => h,
        None => return false,
    };
    if !is_loopback(host) {
        return false;
    }
    if target.port_or_known_default() != Some(port) {
        return false;
    }
    is_consent_path(target.path())
}

/// 拒绝导航的日志行（拒绝要**可 grep**）。
///
/// ⚠️ 只记 scheme / host / port / path——**不记 query、不记 userinfo**：
/// 被拒 URL 里可能带着对方塞进来的凭据，写进日志等于换一个地方泄漏。
pub fn consent_nav_denied_line(target: &Url) -> String {
    format!(
        "[studio] level=warn consent navigation denied: scheme={} host={} port={} path={}",
        target.scheme(),
        target.host_str().unwrap_or("-"),
        target
            .port_or_known_default()
            .map(|p| p.to_string())
            .unwrap_or_else(|| "-".to_string()),
        target.path()
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// init script
// ─────────────────────────────────────────────────────────────────────────────

/// 该窗的 init script：只做两件事——注入 `__STUDIO_TOKEN__` / `__STUDIO_API_ORIGIN__`，
/// 然后**删掉裸 `__TAURI_INTERNALS__`**。
///
/// 与 MCP 设置窗（`main.rs:mcp_settings_init_script`）的差别只有一处、且是**收紧**：
/// 这里连 `__studioXxx()` 这样的 invoke 闭包都不暴露——审批页只需要 HTTP，
/// 不需要任何 Tauri command。不暴露 = 页面即便被同源 XSS，也没有一条通往 IPC 的路。
///
/// token 走 init script、**不落 HTML**：页面本体不含秘密，所以「页面壳免鉴权」不等于
/// 「秘密免鉴权」。**但注入的仍是宿主全权 token**——与 MCP 窗同一笔 P2 债务
/// （该窗一旦被 XSS = 宿主全权失守），scope 化另立卡，本卡不混。
pub fn consent_init_script(token: &str, origin: &str) -> String {
    let token_js = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    let origin_js = serde_json::to_string(origin).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(){{\n\
          try {{\n\
            window.__STUDIO_TOKEN__ = {token};\n\
            window.__STUDIO_API_ORIGIN__ = {origin};\n\
            try {{ delete window.__TAURI_INTERNALS__; }} catch (e) {{}}\n\
          }} catch (e) {{ /* 注入失败 → 页面 fail-visible（读不到 token 就不发请求），不静默放行 */ }}\n\
        }})();\n",
        token = token_js,
        origin = origin_js
    )
}

/// 建窗前的纯计划：token 空 ⇒ `Err("no-token")`（fail-closed），否则给出 (url, init script)。
///
/// 抽出来是为了让「token 空不开窗」这条能被单测钉住——否则它只能靠真机验证，
/// 而真机验证在本卡里是被禁止的（8760 被装版占着）。
fn window_plan(token: &str, host: &str, port: u16) -> Result<(Url, String), String> {
    if token.is_empty() {
        return Err("no-token".to_string());
    }
    let url = Url::parse(&consent_window_url(host, port))
        .map_err(|e| format!("invalid consent-window url: {}", e))?;
    let origin = format!("http://{}:{}", host, port);
    Ok((url, consent_init_script(token, &origin)))
}

// ─────────────────────────────────────────────────────────────────────────────
// 待审批探测（HTTP 客户端 + 响应解析）
// ─────────────────────────────────────────────────────────────────────────────

/// 一次探测的结果。
///
/// `call_id` 为 `None` 可能是「没有 pending」也可能是「有 pending 但宿主没给 id」，
/// 所以两者分开：`pending` 决定开/关窗，`call_id` 只用于**去重**（同一请求不重复建窗）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PendingProbe {
    pub pending: bool,
    pub call_id: Option<String>,
}

impl PendingProbe {
    pub fn none() -> Self {
        PendingProbe {
            pending: false,
            call_id: None,
        }
    }
}

/// 拼一个最小的 HTTP/1.1 GET。
///
/// `Connection: close` 是刻意的：不实现 keep-alive，读到手就断，解析逻辑不用管分帧。
pub fn build_get_request(host: &str, port: u16, path: &str, token: &str, origin: &str) -> String {
    format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host}:{port}\r\n\
         Authorization: Bearer {token}\r\n\
         Origin: {origin}\r\n\
         Accept: application/json\r\n\
         Connection: close\r\n\
         \r\n",
        path = path,
        host = host,
        port = port,
        token = token,
        origin = origin
    )
}

/// 解 chunked 正文。**必须支持**：宿主侧 `sendJson()` 用 `res.writeHead(...)` + `res.end(body)`，
/// Node 在这条路径上可能给 `Transfer-Encoding: chunked`（也可能给 Content-Length，两种都要能读）。
///
/// ⚠️ 按**字节**切片而不是 `&str` 切片：chunk 长度是字节数，正文里只要有一个多字节 UTF-8
/// 字符，`&str` 在同样的偏移上就会 panic（`byte index N is not a char boundary`）。
/// 这条不是理论风险——审批摘要里必然出现中文工具名/路径。
///
/// 解不动（半截、长度行不是十六进制）⇒ 返回已解出的部分；解析失败最终体现为「没有 pending」，
/// 即 fail-closed（不开窗），不会误开。
pub fn decode_chunked(body: &str) -> String {
    let bytes = body.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut pos = 0usize;
    loop {
        let line_end = match bytes[pos..].windows(2).position(|w| w == b"\r\n") {
            Some(i) => pos + i,
            None => break,
        };
        let size_line = match std::str::from_utf8(&bytes[pos..line_end]) {
            Ok(s) => s,
            Err(_) => break,
        };
        // 允许 chunk 扩展：`1a;name=value`
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let size = match usize::from_str_radix(size_hex, 16) {
            Ok(0) => break, // 终止块
            Ok(n) => n,
            Err(_) => break,
        };
        let data_start = line_end + 2;
        let data_end = data_start.saturating_add(size);
        if data_end > bytes.len() {
            out.extend_from_slice(&bytes[data_start..]);
            break;
        }
        out.extend_from_slice(&bytes[data_start..data_end]);
        pos = data_end;
        if bytes[pos..].starts_with(b"\r\n") {
            pos += 2;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 解析 HTTP 响应：`(status, body)`。
///
/// 只认「首行 HTTP/x.y STATUS ...」+ 空行分界；正文按 `Transfer-Encoding: chunked` 决定要不要解块。
pub fn parse_http_response(raw: &str) -> Option<(u16, String)> {
    let (head, body) = raw.split_once("\r\n\r\n")?;
    let mut lines = head.lines();
    let status = lines
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    let chunked = lines.any(|l| {
        let lower = l.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    Some((status, if chunked { decode_chunked(body) } else { body.to_string() }))
}

/// 解析 `/v1/consent/pending` 的正文（**纯函数**，可单测）。
///
/// 线协议（K2 落同一份）：
/// ```json
/// { "ok": true, "pending": { "callId": "...", "tool": "...", "risk": "high", "mode": "auto" } }
/// { "ok": true, "pending": null }
/// ```
/// 宽容三处，但**只往「不开窗」方向宽容**：
///   - 解析失败 / 没有 `pending` 键 ⇒ 没有 pending；
///   - `pending: true`（宿主只报状态不报 id）⇒ 有 pending、id 未知；
///   - 顶层直接给 `callId`（K2 若选择扁平形状）⇒ 认。
pub fn parse_pending_body(body: &str) -> PendingProbe {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return PendingProbe::none(),
    };
    match value.get("pending") {
        Some(serde_json::Value::Null) => PendingProbe::none(),
        Some(serde_json::Value::Bool(true)) => PendingProbe {
            pending: true,
            call_id: None,
        },
        Some(serde_json::Value::Object(obj)) => PendingProbe {
            pending: true,
            call_id: obj
                .get("callId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        },
        Some(_) => PendingProbe::none(),
        None => match value.get("callId").and_then(|v| v.as_str()) {
            Some(id) => PendingProbe {
                pending: true,
                call_id: Some(id.to_string()),
            },
            None => PendingProbe::none(),
        },
    }
}

/// 一次 GET。失败一律 `None`（连接不上 / 超时 / 响应不是 HTTP）——**探测失败不等于有请求**。
///
/// ⚠️ 这里刻意不引入 reqwest：本机回环上的一次状态查询不值得一整棵 TLS/async 依赖树，
/// 而 `std::net` 的路径能单测（起一个假服务端逐字节核请求头）。stderr 不打印 token。
fn http_get(
    host: &str,
    port: u16,
    path: &str,
    token: &str,
    origin: &str,
    timeout: Duration,
) -> Option<(u16, String)> {
    let addr = (host, port).to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(build_get_request(host, port, path, token, origin).as_bytes())
        .ok()?;
    let _ = stream.flush();

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= MAX_RESPONSE_BYTES {
                    break;
                }
            }
            // 超时/对端断开：已读到的部分照样解析（`Connection: close` 下等价于读到末尾）。
            Err(_) => break,
        }
    }
    parse_http_response(&String::from_utf8_lossy(&buf))
}

/// 探测待审批。**返回 `Option<PendingProbe>`：`None` = 这次没问出结论**（连不上 / 超时 /
/// 非 200 状态码），与 `Some(none())`（问到了：确实没有请求）**语义不同**。
///
/// 为什么要区分：轮询线程要按「有没有结论」决定退避。混成一个 `bool` 会导致
/// K2 端点还没上线时每 200ms 一次 TCP 尝试、永不退避（≈5 conn/s 静默空转）。
/// 401/403/404 都不是「有请求待批准」，但也**不是「没有请求」**。
pub fn poll_pending(
    host: &str,
    port: u16,
    token: &str,
    origin: &str,
    timeout: Duration,
) -> Option<PendingProbe> {
    match http_get(host, port, CONSENT_PENDING_PATH, token, origin, timeout) {
        Some((200, body)) => Some(parse_pending_body(&body)),
        _ => None,
    }
}

/// 轮询退避（**纯函数 + 状态**，可单测）。
///
/// 取值理由：
///   - 正常路径（问出结论）恒 `POLL_INTERVAL`（200ms）——设计稿写死，不动；
///   - 问不出结论时从 200ms 起，每次 ×2，封顶 `MAX_IDLE_POLL`（5s）。
///     5s 的代价是「K2 上线后最多晚 5s 才弹第一个审批窗」，而代价的对价是
///     端点不存在期间从 ≈5 conn/s 降到 ≈0.2 conn/s（同一段时间里的连接数降 25 倍）。
///     这只发生在**异常态**，正常情况下永远走 200ms。
///   - 退避**必须能被一次成功立即全额重置**：否则端点恢复后仍要等满当前退避，
///     用户会看到「审批窗口慢半拍弹出来」。
#[derive(Debug)]
pub struct PollBackoff {
    next: Duration,
}

/// 退避上限。
pub const MAX_IDLE_POLL: Duration = Duration::from_secs(5);

impl Default for PollBackoff {
    fn default() -> Self {
        PollBackoff { next: POLL_INTERVAL }
    }
}

impl PollBackoff {
    /// 记一次探测结果，返回**本拍之后该睡多久**。
    pub fn after(&mut self, answered: bool) -> Duration {
        if answered {
            self.next = POLL_INTERVAL;
            return self.next;
        }
        let doubled = self.next.saturating_mul(2);
        self.next = if doubled > MAX_IDLE_POLL { MAX_IDLE_POLL } else { doubled };
        self.next
    }

    /// 当前睡多久（不进位）。
    pub fn current(&self) -> Duration {
        self.next
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 开/关窗的决策状态机（纯逻辑，可单测）
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentPollAction {
    /// 什么都不做（窗已在该在的状态）。
    Hold,
    /// 有 pending 且窗没开 ⇒ 开（或复用）。
    Open,
    /// pending 消失且窗还开着 ⇒ 关（destroy，不 hide）。
    Close,
}

/// 轮询决策。（`dismissed_call` 见 `PollTracker::observe`）
pub fn decide_poll_action(
    pending: bool,
    call_id: Option<&str>,
    window_open: bool,
    dismissed_call: Option<&str>,
) -> ConsentPollAction {
    if !pending {
        return if window_open {
            ConsentPollAction::Close
        } else {
            ConsentPollAction::Hold
        };
    }
    if window_open {
        return ConsentPollAction::Hold;
    }
    // 有一条请求、窗却没开：除非用户刚刚亲手关掉了**这一条**，否则开窗。
    if dismissed_call.is_some() && dismissed_call == call_id.or(Some("")) {
        return ConsentPollAction::Hold;
    }
    ConsentPollAction::Open
}

/// 轮询的跨拍记忆：唯一职责是**认得出「用户亲手关掉了哪一条」**。
///
/// 为什么需要它：卡面要求「关窗即毁、无请求就关窗」。但如果照字面实现，
/// 用户点 X 关掉审批窗 ⇒ 200ms 后宿主仍报 pending ⇒ 窗子自己又弹出来，
/// 形成「用户关不掉」的拉锯。所以：**上一拍开着、这一拍关了、请求还是同一条**
/// ⇒ 判定为「用户丢弃了这一条」，不再自动重开；等它被宿主判超时/deny，
/// 或换成一个新的 `callId`（新请求照样弹窗）。
#[derive(Debug, Default, Clone)]
pub struct PollTracker {
    seen_open: bool,
    dismissed_call: Option<String>,
}

impl PollTracker {
    pub fn observe(&mut self, pending: bool, call_id: Option<&str>, window_open: bool) -> ConsentPollAction {
        // ① 用户刚关掉窗（上一拍开着、这一拍关着）且请求仍在 ⇒ 记为「本条被丢弃」
        if self.seen_open && !window_open && pending {
            self.dismissed_call = Some(call_id.unwrap_or("").to_string());
        }
        // ② 请求消失、或换成了新的 callId ⇒ 丢弃标记失效
        match (pending, call_id) {
            (false, _) => self.dismissed_call = None,
            (true, Some(id)) => {
                if self.dismissed_call.as_deref() != Some(id) {
                    self.dismissed_call = None;
                }
            }
            (true, None) => {}
        }
        let action = decide_poll_action(pending, call_id, window_open, self.dismissed_call.as_deref());
        // ③ 本拍决定关窗 ⇒ 窗在语义上已经没了。不记这一步，下一拍就会把「我们自己关的窗」
        //    读成「用户亲手关的窗」，从而把**下一条**请求也一并压住（真缺陷，单测已钉）。
        self.seen_open = match action {
            ConsentPollAction::Close => false,
            _ => window_open,
        };
        action
    }

    /// 建窗失败时把这一条压住，避免每 200ms 重试一次、把日志刷成瀑布。
    pub fn mark_dismissed(&mut self, call_id: Option<&str>) {
        self.dismissed_call = Some(call_id.unwrap_or("").to_string());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 建窗（必须在工作线程上调用）
// ─────────────────────────────────────────────────────────────────────────────

/// 同步建窗。**调用方必须保证不在主线程/IPC 回调里**。
///
/// 根因（`open_workbench` 那段实测注释，同一份）：wry 建 webview 是
/// 「投递 + `rx.recv()` 阻塞等事件循环建窗」，在 IPC 回调里等于主线程自锁。
/// 所以 command 路径先 `std::thread::spawn`，轮询线程本身已是 worker，直接调。
fn build_window(
    app: &tauri::AppHandle,
    host: &str,
    port: u16,
    token: &str,
) -> Result<(), String> {
    let (url, script) = window_plan(token, host, port)?;
    if !inflight_begin(CONSENT_LABEL) {
        p0_log("consent window build skipped (already inflight)");
        return Ok(());
    }
    let built = WebviewWindowBuilder::new(app, CONSENT_LABEL, WebviewUrl::External(url))
        .title("DeepSeek++ Studio · 审批")
        .inner_size(560.0, 620.0)
        .min_inner_size(420.0, 460.0)
        .initialization_script(&script)
        // 导航白名单：非白名单一律拒 + 写一行可 grep 日志。
        .on_navigation(move |target| {
            let allowed = consent_navigation_allowed(target, port);
            if !allowed {
                grant_log(&consent_nav_denied_line(target));
            }
            allowed
        })
        .build();
    inflight_end(CONSENT_LABEL);
    match built {
        Ok(_) => {
            p0_log(format!(
                "consent window built tracked={:?}",
                app.webview_windows().keys().collect::<Vec<_>>()
            ));
            Ok(())
        }
        Err(e) => Err(format!("failed to create consent window: {}", e)),
    }
}

/// 打开（或复用）审批窗口。幂等：已存在 ⇒ show + unminimize + focus。
///
/// fail-closed 三处：① token 空 ⇒ 不开窗（不开一个「打开了也做不了事」的空窗）；
/// ② URL 解析失败 ⇒ 不开窗；③ 建窗失败 ⇒ 回 Err 由调用方记账，绝不静默当成成功。
pub fn open_window(app: &tauri::AppHandle) -> Result<(), String> {
    // 先判「已存在」再判 token：已开着的窗不需要 token 也能 show/focus，
    // 此时 token 读不到不是失败（config.json 可能是后写的）。
    if let Some(win) = app.get_webview_window(CONSENT_LABEL) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }
    // token 拿不到 ⇒ 留一行可 grep 日志，避免表现为「按钮没反应」
    let token = host_token_from_config();
    if token.is_empty() {
        grant_log(
            "[studio] level=warn consent: no-token (config.json missing/empty) → window not opened",
        );
        return Err("no-token".to_string());
    }
    let (host, port) = studio_host_port();
    // 建窗离开 IPC 回调（本函数由 command 调用，command 在主线程）。
    // AppHandle 是 clone-able 句柄（MCP 设置窗用的是同一个姿势），这里显式 clone
    // 而不是把 `&AppHandle` 借给线程——后者正是 E0521「借用数据逃逸」。
    let app = app.clone();
    std::thread::spawn(move || {
        p0_log("consent window build begin (worker)");
        match build_window(&app, &host, port, &token) {
            Ok(()) => grant_log("[studio] consent window opened (manual)"),
            Err(e) => grant_log(&format!(
                "[studio] level=warn consent: build failed: {}",
                e
            )),
        }
    });
    Ok(())
}

/// 关闭审批窗口：**destroy，不 hide**。
///
/// 「关窗即毁」是设计稿写死的：hide 会让一个仍持有 token 的 webview 活在后台，
/// 下一次 pending 复用时就少了一次重新注入的机会。销毁 = 每条审批一个干净上下文。
fn close_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(CONSENT_LABEL) {
        p0_log("consent window closing (no pending request)");
        let _ = win.destroy();
    }
}

/// K1 command：打开（或复用）审批窗口。注册名 `studio_open_consent_window`。
///
/// 幂等：已存在 ⇒ show + unminimize + focus。fail-closed：token 空 ⇒ Err("no-token")、不开窗。
/// `consent_window::` 前缀进 `generate_handler!` ⇒ ACL id 为 `allow-studio-open-consent-window`
/// （守卫的去前缀规则）。**但它不是给页面用的**：审批窗的 init script 不暴露任何 invoke，
/// 这条 command 的调用方只可能是宿主/人工排障路径。
#[tauri::command]
pub fn studio_open_consent_window(app: tauri::AppHandle) -> Result<(), String> {
    open_window(&app)
}

// ─────────────────────────────────────────────────────────────────────────────
// 轮询的一拍（纯函数——不变量必须有测试锁，不能只靠结构保护）
// ─────────────────────────────────────────────────────────────────────────────

/// **一拍轮询的决策本体**：`probed` 是 `poll_pending` 的结果。
///
/// 核心不变量（有测试钉住，PM 2026-11-09 要求）：
///   **`None`（问不出结论）⇒ 返回 `None` 且 `tracker` 一次都不被调用。**
///
/// 为什么这条值得一枚测试：实现里它原本只靠 `if let Some(probe)` 这个**结构**保护。
/// 将来任何人把它写成 `probe.unwrap_or_default()` 之类的合并，31 枚测试照样全绿，
/// 而线上表现是「**联网抖动一次就把已开着的审批窗关掉**」——这是个静默的安全回归。
/// 抽成纯函数后，这条不变量变成可断言的对象，而不是阅读代码时的默契。
pub fn poll_step(
    probed: Option<PendingProbe>,
    tracker: &mut PollTracker,
    window_open: bool,
) -> Option<ConsentPollAction> {
    let probe = probed?; // ← `None` 在此直接返回，tracker 不可能被触碰
    Some(tracker.observe(probe.pending, probe.call_id.as_deref(), window_open))
}

// ─────────────────────────────────────────────────────────────────────────────
// 后台轮询线程
// ─────────────────────────────────────────────────────────────────────────────

/// 起后台轮询（`setup` 里调一次）。
///
/// 返回 false 表示没起：token 空时宿主端点必然 401，起一个只会空转 200ms 一圈的线程没有意义。
pub fn spawn_poller(app: tauri::AppHandle) -> bool {
    let token = host_token_from_config();
    if token.is_empty() {
        grant_log("[studio] level=warn consent: no-token → poller not started");
        return false;
    }
    std::thread::spawn(move || {
        let (host, port) = studio_host_port();
        let origin = format!("http://{}:{}", host, port);
        let mut tracker = PollTracker::default();
        let mut backoff = PollBackoff::default();
        p0_log("consent poller started");
        loop {
            if SHUTTING_DOWN.load(Ordering::SeqCst) {
                p0_log("consent poller exit (shutdown)");
                break;
            }
            let probed = poll_pending(&host, port, &token, &origin, POLL_HTTP_TIMEOUT);
            let sleep_for = backoff.after(probed.is_some());
            // 日志里要报 callId，而 `poll_step` 会 consume `probed` ⇒ 先把 id 取出来。
            let call_id = probed
                .as_ref()
                .and_then(|p| p.call_id.clone())
                .unwrap_or_else(|| "-".to_string());
            let open = app.get_webview_window(CONSENT_LABEL).is_some();
            // 「问不出结论 ⇒ 不进决策」由 `poll_step` 内部返回 None 保证（有测试锁，
            // 不再依赖调用点的结构）。
            match poll_step(probed, &mut tracker, open) {
                Some(ConsentPollAction::Open) => {
                    // 注意：poll_step 已消费 probed，这里重新取本条 callId 用于日志与抑制
                    match build_window(&app, &host, port, &token) {
                        Ok(()) => grant_log(&format!(
                            "[studio] consent window opened for pending call={}",
                            call_id
                        )),
                        Err(e) => {
                            // 建窗失败只记一次，别按轮询节奏刷屏；该 callId 交给宿主超时兜底。
                            grant_log(&format!(
                                "[studio] level=warn consent: build failed for call={} err={} (suppressed)",
                                call_id, e
                            ));
                            tracker.mark_dismissed(Some(call_id.as_str()));
                        }
                    }
                }
                Some(ConsentPollAction::Close) => close_window(&app),
                Some(ConsentPollAction::Hold) | None => {}
            }
            std::thread::sleep(sleep_for);
        }
    });
    true
}

// ─────────────────────────────────────────────────────────────────────────────
// 单测
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    // ── 窗口 URL / 导航白名单 ────────────────────────────────────────────────

    #[test]
    fn window_url_is_same_origin_as_host() {
        assert_eq!(consent_window_url("127.0.0.1", 8760), "http://127.0.0.1:8760/consent");
        assert_eq!(consent_window_url("localhost", 9999), "http://localhost:9999/consent");
    }

    #[test]
    fn navigation_allows_consent_page_and_its_assets() {
        let p = |s: &str| consent_navigation_allowed(&Url::parse(s).unwrap(), 8760);
        assert!(p("http://127.0.0.1:8760/consent"));
        assert!(p("http://127.0.0.1:8760/consent/"));
        assert!(p("http://127.0.0.1:8760/consent/index.html"));
        assert!(p("http://127.0.0.1:8760/consent.js"));
        assert!(p("http://127.0.0.1:8760/consent.css"));
        assert!(p("http://127.0.0.1:8760/consent?callId=x"));
        assert!(p("http://localhost:8760/consent"));
    }

    /// 负控：这个窗里有宿主全权 token，白名单松一寸就是全权失守一寸。
    #[test]
    fn navigation_denies_everything_else() {
        let p = |s: &str| consent_navigation_allowed(&Url::parse(s).unwrap(), 8760);
        // 路径不在 /consent 段
        assert!(!p("http://127.0.0.1:8760/mcp-settings"));
        assert!(!p("http://127.0.0.1:8760/v1/consent/pending"));
        assert!(!p("http://127.0.0.1:8760/"));
        // 前缀碰撞：只能是段，不能是裸前缀
        assert!(!p("http://127.0.0.1:8760/consentreports"));
        assert!(!p("http://127.0.0.1:8760/consent-admin"));
        // scheme
        assert!(!p("https://127.0.0.1:8760/consent"));
        assert!(!p("file:///C:/Windows/win.ini"));
        // host
        assert!(!p("http://evil.example.com/consent"));
        assert!(!p("http://0.0.0.0:8760/consent"));
        assert!(!p("http://192.168.2.200:8760/consent"));
        // port
        assert!(!p("http://127.0.0.1:8080/consent"));
        assert!(!p("http://127.0.0.1/consent")); // 默认 80 ≠ 8760
    }

    #[test]
    fn nav_denied_line_records_no_query_or_userinfo() {
        let u = Url::parse("https://evil.example.com:8443/consent?token=SEKRET#frag").unwrap();
        let line = consent_nav_denied_line(&u);
        assert!(line.contains("scheme=https"), "{}", line);
        assert!(line.contains("host=evil.example.com"), "{}", line);
        assert!(line.contains("port=8443"), "{}", line);
        assert!(line.contains("path=/consent"), "{}", line);
        assert!(!line.contains("SEKRET"), "query 不得进日志: {}", line);
        assert!(!line.contains('#'), "fragment 不得进日志: {}", line);

        let with_auth = Url::parse("http://user:pw@127.0.0.1:1/consent").unwrap();
        let line2 = consent_nav_denied_line(&with_auth);
        assert!(!line2.contains("user"), "userinfo 不得进日志: {}", line2);
        assert!(!line2.contains("pw"), "userinfo 不得进日志: {}", line2);
    }

    // ── init script ─────────────────────────────────────────────────────────

    #[test]
    fn init_script_injects_token_and_origin() {
        let s = consent_init_script("TOK-123", "http://127.0.0.1:8760");
        assert!(s.contains("window.__STUDIO_TOKEN__ = \"TOK-123\""), "{}", s);
        assert!(
            s.contains("window.__STUDIO_API_ORIGIN__ = \"http://127.0.0.1:8760\""),
            "{}",
            s
        );
    }

    /// 负控：这个窗一个 Tauri command 都不需要，所以**连 invoke 都不许暴露**。
    /// 只捕获不删除不够（MCP 窗的教训：页面照样能自己 invoke），这里是「既不给闭包、又删裸对象」。
    #[test]
    fn init_script_exposes_no_ipc_surface() {
        let s = consent_init_script("TOK-123", "http://127.0.0.1:8760");
        assert!(s.contains("delete window.__TAURI_INTERNALS__"), "{}", s);
        assert!(!s.contains("invoke("), "审批窗不得暴露任何 invoke 路径: {}", s);
        assert!(!s.contains("__studioOpen"), "不得暴露 __studio* 闭包: {}", s);
    }

    #[test]
    fn init_script_escapes_hostile_token() {
        // token 来自 config.json；含引号/换行也不能把脚本拼坏（serde_json 负责转义）
        let s = consent_init_script("a\"b\nc", "http://127.0.0.1:8760");
        assert!(s.contains(r#"window.__STUDIO_TOKEN__ = "a\"b\nc""#), "{}", s);
    }

    // ── fail-closed 计划 ────────────────────────────────────────────────────

    #[test]
    fn empty_token_never_opens_a_window() {
        assert_eq!(window_plan("", "127.0.0.1", 8760), Err("no-token".to_string()));
    }

    #[test]
    fn valid_token_yields_url_and_script() {
        let (url, script) = window_plan("TOK", "127.0.0.1", 8760).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:8760/consent");
        assert!(script.contains("TOK"));
    }

    // ── 响应解析 ────────────────────────────────────────────────────────────

    #[test]
    fn parse_http_response_with_content_length() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        assert_eq!(parse_http_response(raw), Some((200, "{\"ok\":true}".to_string())));
    }

    /// 造一个 chunked 正文（长度自行算，别手数——手数的 `1a` vs 27 字节已经让我红过一次）。
    fn chunked(parts: &[&str]) -> String {
        let mut s = String::new();
        for p in parts {
            s.push_str(&format!("{:x}\r\n{}\r\n", p.len(), p));
        }
        s.push_str("0\r\n\r\n");
        s
    }

    #[test]
    fn parse_http_response_decodes_chunked() {
        // Node 在未设 Content-Length 时用的是 chunked —— 不解块就永远读不出 JSON。
        let raw = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{}",
            chunked(&["{\"a\":", "1}"])
        );
        let (status, body) = parse_http_response(&raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "{\"a\":1}");
    }

    /// 真实风险点：chunk 长度是**字节数**，正文里有中文时按字符切会 panic。
    /// 这条不是假想——审批摘要必然出现中文工具名。
    #[test]
    fn decode_chunked_handles_multibyte_utf8() {
        let payload = "{\"tool\":\"删除记忆\"}";
        let raw = chunked(&[payload]);
        assert_eq!(decode_chunked(&raw), payload);
        // 故意在 UTF-8 中间断一刀（按字节切半个汉字），也必须只做 lossy、不许 panic
        let broken = format!("{:x}\r\n{}\r\n0\r\n\r\n", payload.len() - 1, &payload[..payload.len() - 1]);
        let _ = decode_chunked(&broken);
    }

    #[test]
    fn parse_http_response_rejects_non_http() {
        assert_eq!(parse_http_response(""), None);
        assert_eq!(parse_http_response("not a response"), None);
        assert_eq!(parse_http_response("HTTP/1.1 OK\r\n\r\n"), None);
    }

    #[test]
    fn parse_pending_accepts_documented_shapes() {
        assert_eq!(
            parse_pending_body(r#"{"ok":true,"pending":{"callId":"c1","tool":"python.exec"}}"#),
            PendingProbe {
                pending: true,
                call_id: Some("c1".to_string())
            }
        );
        assert_eq!(parse_pending_body(r#"{"ok":true,"pending":null}"#), PendingProbe::none());
        assert_eq!(
            parse_pending_body(r#"{"ok":true,"pending":true}"#),
            PendingProbe {
                pending: true,
                call_id: None
            }
        );
        // 扁平形状（K2 若选择不带 pending 包裹）
        assert_eq!(
            parse_pending_body(r#"{"callId":"c9"}"#),
            PendingProbe {
                pending: true,
                call_id: Some("c9".to_string())
            }
        );
    }

    /// 负控：任何读不懂的正文都必须落到「没有 pending」——**绝不能因为解析失败去开窗**。
    #[test]
    fn parse_pending_fails_closed_on_garbage() {
        assert_eq!(parse_pending_body(""), PendingProbe::none());
        assert_eq!(parse_pending_body("null"), PendingProbe::none());
        assert_eq!(parse_pending_body("[]"), PendingProbe::none());
        assert_eq!(parse_pending_body(r#"{"pending":"yes"}"#), PendingProbe::none());
        assert_eq!(parse_pending_body(r#"{"ok":false}"#), PendingProbe::none());
    }

    // ── 决策状态机 ──────────────────────────────────────────────────────────

    #[test]
    fn action_opens_on_pending_when_closed() {
        assert_eq!(
            decide_poll_action(true, Some("c1"), false, None),
            ConsentPollAction::Open
        );
    }

    #[test]
    fn action_holds_when_window_already_open() {
        // 复用：同一条请求不重复建窗
        assert_eq!(
            decide_poll_action(true, Some("c1"), true, None),
            ConsentPollAction::Hold
        );
    }

    #[test]
    fn action_closes_when_no_pending() {
        assert_eq!(
            decide_poll_action(false, None, true, None),
            ConsentPollAction::Close
        );
        assert_eq!(decide_poll_action(false, None, false, None), ConsentPollAction::Hold);
    }

    #[test]
    fn tracker_does_not_reopen_a_call_user_dismissed() {
        let mut t = PollTracker::default();
        // 第一拍：有请求、窗没开 ⇒ 开
        assert_eq!(t.observe(true, Some("c1"), false), ConsentPollAction::Open);
        // 第二拍：窗开了 ⇒ 保持
        assert_eq!(t.observe(true, Some("c1"), true), ConsentPollAction::Hold);
        // 第三拍：用户点 X 关掉、请求还在 ⇒ 不许自动弹回来
        assert_eq!(t.observe(true, Some("c1"), false), ConsentPollAction::Hold);
        // 第四拍：仍然不许
        assert_eq!(t.observe(true, Some("c1"), false), ConsentPollAction::Hold);
    }

    #[test]
    fn tracker_reopens_for_a_new_call() {
        let mut t = PollTracker::default();
        assert_eq!(t.observe(true, Some("c1"), false), ConsentPollAction::Open);
        assert_eq!(t.observe(true, Some("c1"), true), ConsentPollAction::Hold);
        assert_eq!(t.observe(true, Some("c1"), false), ConsentPollAction::Hold); // 丢弃 c1
        assert_eq!(t.observe(true, Some("c1"), false), ConsentPollAction::Hold);
        // 换成新请求 ⇒ 丢弃标记失效、照常开窗
        assert_eq!(t.observe(true, Some("c2"), false), ConsentPollAction::Open);
    }

    #[test]
    fn tracker_closes_then_reopens_next_call() {
        let mut t = PollTracker::default();
        assert_eq!(t.observe(true, Some("c1"), false), ConsentPollAction::Open);
        assert_eq!(t.observe(true, Some("c1"), true), ConsentPollAction::Hold);
        // 请求被答复 ⇒ 关窗
        assert_eq!(t.observe(false, None, true), ConsentPollAction::Close);
        // 下一条请求 ⇒ 照常开窗（关窗是回收，不是丢弃）
        assert_eq!(t.observe(true, Some("c2"), false), ConsentPollAction::Open);
    }

    #[test]
    fn mark_dismissed_suppresses_only_that_call() {
        let mut t = PollTracker::default();
        t.mark_dismissed(Some("c1"));
        assert_eq!(t.observe(true, Some("c1"), false), ConsentPollAction::Hold);
        assert_eq!(t.observe(true, Some("c2"), false), ConsentPollAction::Open);
    }

    // ── HTTP 客户端（对假服务端逐字节核请求头）──────────────────────────────

    fn spawn_fake_server(
        response: &'static str,
        captured: Arc<Mutex<String>>,
    ) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    match s.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                if let Ok(mut g) = captured.lock() {
                    *g = String::from_utf8_lossy(&buf).to_string();
                }
                let _ = s.write_all(response.as_bytes());
                let _ = s.flush();
            }
        });
        port
    }

    #[test]
    fn http_get_sends_bearer_and_loopback_origin() {
        let captured = Arc::new(Mutex::new(String::new()));
        let body = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 25\r\n\r\n{\"pending\":{\"callId\":\"c7\"}}";
        let port = spawn_fake_server(body, captured.clone());

        let probe = poll_pending(
            "127.0.0.1",
            port,
            "TOK-ABC",
            "http://127.0.0.1:8760",
            Duration::from_secs(3),
        );
        assert_eq!(
            probe,
            Some(PendingProbe {
                pending: true,
                call_id: Some("c7".to_string())
            })
        );

        let req = captured.lock().unwrap().clone();
        assert!(req.starts_with("GET /v1/consent/pending HTTP/1.1\r\n"), "{}", req);
        assert!(req.contains("Authorization: Bearer TOK-ABC\r\n"), "{}", req);
        assert!(req.contains("Origin: http://127.0.0.1:8760\r\n"), "{}", req);
        assert!(req.contains("Connection: close\r\n"), "{}", req);
        // 负控：token 只许在 Authorization 头里，不许出现在请求行/路径上
        let request_line = req.lines().next().unwrap();
        assert!(!request_line.contains("TOK-ABC"), "{}", request_line);
    }

    #[test]
    fn poll_pending_reads_chunked_response() {
        let captured = Arc::new(Mutex::new(String::new()));
        let body: &'static str = Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{}",
                chunked(&["{\"pending\":{\"callId\":\"c8\"}}"])
            )
            .into_boxed_str(),
        );
        let port = spawn_fake_server(body, captured);
        let probe = poll_pending(
            "127.0.0.1",
            port,
            "T",
            "http://127.0.0.1:8760",
            Duration::from_secs(3),
        );
        assert_eq!(probe.and_then(|p| p.call_id), Some("c8".to_string()));
    }

    /// 负控：401/500 都不是「有请求待批准」，但**也不是「问到结论 = 没有请求」**——
    /// 必须返回 None（没问出结论），否则轮询线程会拿它当正常态、永不退避。
    #[test]
    fn poll_pending_treats_non_200_as_no_answer() {
        let captured = Arc::new(Mutex::new(String::new()));
        let body = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 24\r\n\r\n{\"error\":{\"code\":\"una\"}}";
        let port = spawn_fake_server(body, captured);
        let probe = poll_pending(
            "127.0.0.1",
            port,
            "WRONG",
            "http://127.0.0.1:8760",
            Duration::from_secs(3),
        );
        assert_eq!(probe, None);
    }

    /// 正控：200 + `pending:null` 是**问到了结论**（确实没有请求）⇒ Some(none())，
    /// 退避必须据此立刻回到 200ms。两条混在一起就会让热路径退化。
    #[test]
    fn poll_pending_200_null_is_an_answer_not_a_failure() {
        let captured = Arc::new(Mutex::new(String::new()));
        let body = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 25\r\n\r\n{\"ok\":true,\"pending\":null}";
        let port = spawn_fake_server(body, captured);
        let probe = poll_pending(
            "127.0.0.1",
            port,
            "T",
            "http://127.0.0.1:8760",
            Duration::from_secs(3),
        );
        assert_eq!(probe, Some(PendingProbe::none()));
    }

    #[test]
    fn poll_pending_returns_none_when_nothing_listens() {
        // 取一个刚释放的回环端口：连不上 ⇒ 没问出结论（不是 Some(none())）
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let probe = poll_pending(
            "127.0.0.1",
            port,
            "T",
            "http://127.0.0.1:8760",
            Duration::from_millis(300),
        );
        assert_eq!(probe, None);
    }

    /// PM 2026-11-09 点名要的那枚锁：**问不出结论 ⇒ 不碰 tracker、不产出动作**。
    ///
    /// 装置自检在**同一条用例里**做（比分开更硬）：先用真值证明「同样一条 pending 若被传入，
    /// 是会产生 Open 的」——否则下面那句 `assert_eq!(.., None)` 可能只是「传什么都返回 None」
    /// 的空跑。
    #[test]
    fn poll_step_never_touches_tracker_without_an_answer() {
        // ① 装置自检：同一条 pending 真的会产出 Open（证明这名 tracker 是会反应的）
        let mut live = PollTracker::default();
        let pending = Some(PendingProbe {
            pending: true,
            call_id: Some("c1".to_string()),
        });
        assert_eq!(
            poll_step(pending.clone(), &mut live, false),
            Some(ConsentPollAction::Open),
            "装置自检：这条 pending 本该产出 Open，否则下面的 None 断言是在空跑"
        );

        // ② 主断言：把「没问出结论」喂进去 ⇒ 必须 None
        let mut t = PollTracker::default();
        assert_eq!(poll_step(None, &mut t, true), None);
        // ③ 关键：tracker **一次都没被调用**。若被当成「没有 pending」喂进去，
        //    这里会变成 Some(Close)——那正是「联网抖动误关已开着的窗」。
        assert_eq!(
            poll_step(None, &mut t, true),
            None,
            "问不出结论绝不能产出 Close（把窗误关），也不能产出任何动作"
        );
        assert_eq!(t.seen_open, false, "None 这一支不得改动 tracker 状态");
        assert_eq!(t.dismissed_call, None, "None 这一支不得产生「丢弃」标记");

        // ④ 对照组：真的问到「没有请求」⇒ Close（证明两态语义确实被区分开了）
        let mut u = PollTracker::default();
        u.observe(true, Some("c1"), true); // 先让它处于「窗开着」
        assert_eq!(
            poll_step(Some(PendingProbe::none()), &mut u, true),
            Some(ConsentPollAction::Close)
        );
    }

    // ── 轮询退避 ────────────────────────────────────────────────────────────

    /// 正常路径（每拍都问出结论）必须恒 200ms —— 设计稿写死的节奏不许被退避拖慢。
    #[test]
    fn backoff_stays_at_poll_interval_on_the_happy_path() {
        let mut b = PollBackoff::default();
        for _ in 0..50 {
            assert_eq!(b.after(true), POLL_INTERVAL);
        }
        assert_eq!(b.after(true), POLL_INTERVAL);
    }

    /// 异常路径：连续问不出结论 ⇒ 指数退避，封顶 MAX_IDLE_POLL，且**永不回到 200ms 以下不变**。
    #[test]
    fn backoff_grows_and_is_capped_when_nothing_answers() {
        let mut b = PollBackoff::default();
        let seq: Vec<u64> = (0..8).map(|_| b.after(false).as_millis() as u64).collect();
        assert_eq!(seq, vec![400, 800, 1600, 3200, 5000, 5000, 5000, 5000], "{:?}", seq);
        // 长时间空转也不能溢出/回绕（saturating_mul + 封顶）
        for _ in 0..10_000 {
            let _ = b.after(false);
        }
        assert_eq!(b.current(), MAX_IDLE_POLL);
    }

    /// 端点恢复后必须**一刀回到 200ms**：否则用户会看到审批窗慢半拍。
    #[test]
    fn backoff_resets_immediately_on_first_answer() {
        let mut b = PollBackoff::default();
        for _ in 0..6 {
            let _ = b.after(false);
        }
        assert_eq!(b.current(), MAX_IDLE_POLL);
        assert_eq!(b.after(true), POLL_INTERVAL);
        assert_eq!(b.current(), POLL_INTERVAL);
    }

    /// 量化「端点不存在期间的连接数」：K2 上线前这段窗口里，退避把连接数砍掉一个数量级以上。
    #[test]
    fn backoff_cuts_idle_connections_by_an_order_of_magnitude() {
        // 假设端点缺位 60s：不变量是「退避版在此窗口内的轮询次数远小于无退避版」
        let plain_polls = 60_000 / POLL_INTERVAL.as_millis() as u64; // 300 次
        let mut b = PollBackoff::default();
        let mut elapsed = 0u64;
        let mut backed_polls = 0u64;
        while elapsed < 60_000 {
            backed_polls += 1;
            elapsed += b.after(false).as_millis() as u64;
        }
        assert_eq!(plain_polls, 300);
        assert!(
            backed_polls * 10 <= plain_polls,
            "退避应把 60s 内的连接数砍到十分之一以下：退避版={} 无退避版={}",
            backed_polls,
            plain_polls
        );
    }
}
