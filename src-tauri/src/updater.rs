// 自动更新：Tauri command 侧（Rust）。
//
// 背景（发布后 Verify 确证）：「updater 包/签名/端点/Release 全就绪，但全仓 `check_update`
// 调用点 = 0」→ 用户永远收不到更新提示。本模块补上**调用点**。
//
// 通道选择（路线 (a)，已核不再改）：注入脚本已在用 `__TAURI_INTERNALS__.invoke`
// （见 src/desktop/entry.ts 的 open_bot_window），所以这里用 **command 拉取**，不用
// event `listen` —— 后者需要 withGlobalTauri 或 @tauri-apps/api，会额外开安全面。
//
// fail-safe 纪律：
//   - `updater_check` 返回 `null` 同时表示「无更新」与「检查失败」——**绝不把网络错误
//     当更新提示弹给用户**。
//   - 进程内**一次性缓存**：启动 +60s 的自动检查与页端手动检查共用同一次上游请求，
//     避免页面一打开就打一次 GitHub API。
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use tauri_plugin_updater::UpdaterExt;

/// 更新信息（给页端卡片的载荷）。
///
/// `rename_all = "camelCase"`：页端（`src/ui/update-card.ts`）读的是 `currentVersion`。
/// P3-1（Verify 0.14.4 真机确证）：此前默认 snake_case 输出 `current_version`，页端拿不到，
/// 卡片标题的「（当前 x.y.z）」后缀**永不渲染**。改由 Rust 侧对齐（UI 代码零改动），
/// 并有 `update_info_serializes_camel_case` 单测锁死，防止有人改回蛇形。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 新版本号（如 "0.14.1"）。
    pub version: String,
    /// 当前版本号。
    pub current_version: String,
    /// 发布说明（可空）。
    pub notes: String,
}

/// 下载安装进度（页端每 500ms 轮询）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum UpdateProgress {
    /// 空闲 / 尚未开始。
    Idle,
    /// 下载中。
    Downloading { downloaded: u64, total: Option<u64> },
    /// 下载完成、已安装，等待重启。
    Done,
    /// 失败（附原因）。
    Error { error: String },
}

/// 进程内更新状态。
struct UpdaterState {
    /// 一次性检查缓存：Some(None) = 检查过、无更新；Some(Some(info)) = 有更新。
    checked: Mutex<Option<Option<UpdateInfo>>>,
    /// 当前进度。
    progress: Mutex<UpdateProgress>,
    /// 是否已在下载/安装（防止重复点击）。
    installing: Mutex<bool>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            checked: Mutex::new(None),
            progress: Mutex::new(UpdateProgress::Idle),
            installing: Mutex::new(false),
        }
    }
}

/// 真正打一次上游检查（不缓存）。
async fn do_check(app: &AppHandle) -> Option<UpdateInfo> {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[studio] updater init failed: {e}");
            return None;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => Some(UpdateInfo {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone().unwrap_or_default(),
        }),
        Ok(None) => None,
        Err(e) => {
            // fail-safe：网络错误/端点 404（无 Release）都走这里 → 静默，不打扰用户
            eprintln!("[studio] updater check failed (fail-safe, ignored): {e}");
            None
        }
    }
}

/// `updater_check`：返回 `null` = 无更新或检查失败；有更新返回 `UpdateInfo`。
///
/// 进程内一次性缓存（`force=false` 时）。`force` 仅供将来「手动点检查」用。
#[tauri::command]
pub async fn updater_check(app: AppHandle, force: Option<bool>) -> Result<Option<UpdateInfo>, String> {
    let state = app.state::<UpdaterState>();
    let force = force.unwrap_or(false);
    if !force {
        let cached = state.checked.lock().map_err(|e| e.to_string())?.clone();
        if let Some(c) = cached {
            return Ok(c);
        }
    }
    let info = do_check(&app).await;
    let mut guard = state.checked.lock().map_err(|e| e.to_string())?;
    *guard = Some(info.clone());
    Ok(info)
}

/// `updater_progress`：页端轮询下载进度。
#[tauri::command]
pub fn updater_progress(app: AppHandle) -> Result<UpdateProgress, String> {
    let state = app.state::<UpdaterState>();
    let p = state.progress.lock().map_err(|e| e.to_string())?.clone();
    Ok(p)
}

/// `updater_install`：下载并安装（异步，进度写 `progress`）。
///
/// 返回 `{started:true}` 立即返回；实际进度由 `updater_progress` 轮询。
/// 重复调用被 `installing` 门挡掉（幂等）。
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<serde_json::Value, String> {
    {
        let state = app.state::<UpdaterState>();
        let mut installing = state.installing.lock().map_err(|e| e.to_string())?;
        if *installing {
            return Ok(serde_json::json!({ "started": false, "reason": "already-installing" }));
        }
        *installing = true;
        *state.progress.lock().map_err(|e| e.to_string())? = UpdateProgress::Downloading {
            downloaded: 0,
            total: None,
        };
    }

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app2.state::<UpdaterState>();
        let set = |p: UpdateProgress| {
            if let Ok(mut g) = state.progress.lock() {
                *g = p;
            }
        };
        let updater = match app2.updater() {
            Ok(u) => u,
            Err(e) => {
                set(UpdateProgress::Error { error: format!("updater init: {e}") });
                if let Ok(mut g) = state.installing.lock() { *g = false; }
                return;
            }
        };
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => {
                set(UpdateProgress::Error { error: "no update available".into() });
                if let Ok(mut g) = state.installing.lock() { *g = false; }
                return;
            }
            Err(e) => {
                set(UpdateProgress::Error { error: format!("check: {e}") });
                if let Ok(mut g) = state.installing.lock() { *g = false; }
                return;
            }
        };
        // 下载 + 安装。进度回调里更新 state。
        let state_for_cb = app2.state::<UpdaterState>();
        let mut downloaded: u64 = 0;
        let res = update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    if let Ok(mut g) = state_for_cb.progress.lock() {
                        *g = UpdateProgress::Downloading { downloaded, total };
                    }
                },
                || {},
            )
            .await;
        match res {
            Ok(()) => set(UpdateProgress::Done),
            Err(e) => set(UpdateProgress::Error { error: format!("install: {e}") }),
        }
        // 显式用 state_for_cb 而非 state：后者在 spawn 块尾部销毁顺序与临时 MutexGuard 冲突（E0597）
        {
            let cleared = state_for_cb.installing.lock().map(|mut g| {
                *g = false;
            });
            let _ = cleared;
        }
    });

    Ok(serde_json::json!({ "started": true }))
}

/// 启动后自动检查（每次运行至多一次；失败静默）。
///
/// 延迟 60s：不与启动时的带宽/CPU 竞争；也不在用户刚打开就弹窗。
pub fn spawn_startup_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(60)).await;
        // 复用缓存路径：若页端已先查过，这里直接命中缓存，不会二次打上游
        let _ = updater_check(app, None).await;
    });
}

/// 极简 sleep（不引入 tokio 直接依赖）。
async fn tokio_sleep(d: Duration) {
    let start = Instant::now();
    while start.elapsed() < d {
        let remain = d.saturating_sub(start.elapsed());
        let step = remain.min(Duration::from_millis(500));
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(step))
            .await
            .ok();
    }
}

/// 在 app 上注册 updater 状态（`manage`）。
pub fn init_state(app: &AppHandle) {
    app.manage(UpdaterState::default());
}

#[cfg(test)]
mod tests {
    use super::{UpdateInfo, UpdateProgress};

    /// P3-1 回归：页端读 `currentVersion`。若有人去掉 `rename_all = "camelCase"`，
    /// 载荷会变回 `current_version`，卡片「（当前 x.y.z）」后缀又会静默消失 —— 本用例必红。
    #[test]
    fn update_info_serializes_camel_case() {
        let info = UpdateInfo {
            version: "0.14.5".into(),
            current_version: "0.14.4".into(),
            notes: "notes".into(),
        };
        let v = serde_json::to_value(&info).expect("serialize UpdateInfo");
        assert_eq!(v["version"], "0.14.5");
        assert_eq!(v["currentVersion"], "0.14.4", "页端读的是 currentVersion");
        assert!(
            v.get("current_version").is_none(),
            "snake_case 字段会让卡片「当前版本」后缀永不渲染（P3-1）"
        );
        assert_eq!(v["notes"], "notes");
    }

    /// 进度载荷的形状是页端状态机（idle/downloading/done/error）的契约。
    #[test]
    fn progress_states_keep_their_wire_shape() {
        assert_eq!(
            serde_json::to_value(UpdateProgress::Idle).unwrap()["state"],
            "idle"
        );
        let downloading = serde_json::to_value(UpdateProgress::Downloading {
            downloaded: 10,
            total: Some(100),
        })
        .unwrap();
        assert_eq!(downloading["state"], "downloading");
        assert_eq!(downloading["downloaded"], 10);
        assert_eq!(downloading["total"], 100);
        assert_eq!(
            serde_json::to_value(UpdateProgress::Done).unwrap()["state"],
            "done"
        );
        let err = serde_json::to_value(UpdateProgress::Error {
            error: "boom".into(),
        })
        .unwrap();
        assert_eq!(err["state"], "error");
        assert_eq!(err["error"], "boom");
    }
}
