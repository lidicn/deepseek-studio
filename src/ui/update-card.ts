/**
 * 更新卡（TD-updater 卡 · UI 侧）：发现新版本时在主窗右下角弹一张非模态小卡。
 *
 * 契约（Core 的 Rust 侧三命令，进程内一次性缓存 + fail-safe）：
 *   - `invoke('updater_check')`   → `null | { version, notes, currentVersion }`
 *     **null 是正常路径**（无更新 / 检查失败 / 网络错误）→ 不弹任何提示（fail-safe）。
 *   - `invoke('updater_install')` → `{ started: true|false }`，立刻返回；
 *     进度**必须**轮询 `invoke('updater_progress')`（500ms 间隔），不等它的返回值当完成信号。
 *   - `invoke('updater_progress')` → `{ state: 'idle'|'downloading'|'ready'|'done'|'error', downloaded?, total?, error? }`
 *
 * 「下次再说」口径：`localStorage['studio.update.skipVersion'] = version`（纯页端状态，
 * 同版本不再弹；新版本来了版本号不同 → 照常弹）。
 *
 * 纪律：走 `__TAURI_INTERNALS__.invoke`（先例 entry.ts open_workbench），非 Tauri 环境
 * 静默跳过；不 import studio-ui-core（与 agent-mcp-editor 同惯例），不经过工具通道。
 */

export interface UpdateInfo {
  version: string;
  notes?: string;
  currentVersion?: string;
}

export interface TauriInternals {
  invoke?: (cmd: string, args?: Record<string, unknown>) => unknown;
}

export interface UpdateCardHandle {
  /** 关卡（测试与「下次再说」复用）。 */
  close(): void;
  /** 卡片根节点。 */
  readonly root: HTMLElement;
}

export const UPDATE_SKIP_KEY = 'studio.update.skipVersion';

/** 当前版本是否被用户「下次再说」过。 */
export function isUpdateSkipped(version: string): boolean {
  try {
    return globalThis.localStorage?.getItem(UPDATE_SKIP_KEY) === version;
  } catch {
    return false;
  }
}

/** 记一次「下次再说」（同版本不再弹）。 */
export function skipUpdateVersion(version: string): void {
  try {
    globalThis.localStorage?.setItem(UPDATE_SKIP_KEY, version);
  } catch {
    /* 隐私模式等：记不了就算了，不影响关卡 */
  }
}

/** 调 `updater_check`（null = 无更新/失败，fail-safe，绝不抛给用户）。 */
export function checkUpdate(internals: TauriInternals): Promise<UpdateInfo | null> {
  return Promise.resolve(internals.invoke?.('updater_check'))
    .then((r): UpdateInfo | null => {
      if (!r || typeof r !== 'object') return null;
      const v = (r as UpdateInfo).version;
      return typeof v === 'string' && v.length > 0 ? (r as UpdateInfo) : null;
    })
    .catch((e: unknown) => {
      // fail-safe 不变（仍返回 null、不弹错给用户），但拒绝值留痕（P1 缺陷卡③：
      // 此前 `.catch(() => null)` 把「Command … not allowed by ACL」这类错误静默吞掉，
      // 真机上零线索——Verify v0.14.2 验收正是被这个静默坑住的）。
      if (typeof e === 'string' && e.length > 0) console.debug('[StudioUI] updater_check rejected:', e);
      else if (e instanceof Error && e.message) console.debug('[StudioUI] updater_check rejected:', e.message);
      return null;
    });
}

/**
 * 渲染更新卡（body 右下角浮动，z-index 低于 Studio 浮层之上的普通内容但高于正文；
 * 非模态，不挡任何操作）。返回句柄。
 *
 * 按钮行为：
 *  - 「立即更新」→ `invoke('updater_install')` → 每 500ms 轮询 `updater_progress`：
 *    downloading 显示进度条（downloaded/total）；done → 文案变「已更新，重启生效」+「关闭」；
 *    error → 显示错误行（Rust 侧 fail-safe 保证 error 只是安装失败，不崩）。
 *  - 「下次再说」→ `skipUpdateVersion` + 关卡。
 */
export function showUpdateCard(info: UpdateInfo, internals: TauriInternals): UpdateCardHandle {
  const root = document.createElement('div');
  root.id = 'studio-update-card';
  root.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483633',
    'max-width:340px',
    'padding:14px 16px',
    'border-radius:10px',
    'background:var(--studio-card,#1f2430)',
    'color:var(--studio-ink,#e8eaf0)',
    'box-shadow:0 8px 28px rgba(0,0,0,.45)',
    'font:13px/1.5 system-ui,sans-serif',
  ].join(';');

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:6px';
  const titleText = document.createElement('span');
  titleText.textContent = `发现新版本 v${info.version}`;
  title.appendChild(titleText);
  if (info.currentVersion) {
    const cur = document.createElement('span');
    cur.style.cssText = 'color:#8b93a7;font-weight:400';
    cur.textContent = `（当前 ${info.currentVersion}）`;
    title.appendChild(cur);
  }

  let notesEl: HTMLElement | null = null;
  if (info.notes && info.notes.trim()) {
    notesEl = document.createElement('div');
    notesEl.style.cssText = 'margin:6px 0;color:#a9b1c4;max-height:80px;overflow:auto;white-space:pre-wrap';
    notesEl.textContent = info.notes;
  }

  const progressRow = document.createElement('div');
  progressRow.style.cssText = 'display:none;margin:8px 0';
  const progressFill = document.createElement('div');
  progressFill.style.cssText =
    'height:4px;border-radius:2px;background:#5b8cff;width:0%';
  progressRow.appendChild(progressFill);

  const status = document.createElement('div');
  status.style.cssText = 'min-height:1.2em;margin:4px 0;font-size:12px;color:#a9b1c4';

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;margin-top:10px';
  const mkBtn = (text: string, primary: boolean): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = [
      'border:none',
      'border-radius:6px',
      'padding:6px 14px',
      'cursor:pointer',
      'font-size:13px',
      primary
        ? 'background:#5b8cff;color:#fff'
        : 'background:transparent;color:#a9b1c4;border:1px solid #3a4157',
    ].join(';');
    return b;
  };
  const btnInstall = mkBtn('立即更新', true);
  const btnLater = mkBtn('下次再说', false);
  btns.appendChild(btnInstall);
  btns.appendChild(btnLater);

  root.append(title, progressRow, status);
  if (notesEl) root.insertBefore(notesEl, progressRow);
  root.appendChild(btns);
  document.body.appendChild(root);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const close = (): void => {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    root.remove();
  };

  const pollProgress = (): void => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (disposed) return;
      void Promise.resolve(internals.invoke?.('updater_progress'))
        .then((r) => {
          if (disposed || !r || typeof r !== 'object') return;
          const p = r as { state: string; downloaded?: number; total?: number; error?: string };
          switch (p.state) {
            case 'downloading': {
              progressRow.style.display = '';
              const pct = p.total && p.total > 0 ? Math.min(100, Math.round(((p.downloaded ?? 0) / p.total) * 100)) : 5;
              progressFill.style.width = `${pct}%`;
              status.textContent = `正在下载 ${pct}%…`;
              break;
            }
            case 'ready':
            case 'done': {
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              progressRow.style.display = '';
              progressFill.style.width = '100%';
              status.textContent = '';
              // 装完：按钮换成「已更新，重启生效」+ 关闭。
              btnInstall.textContent = '已更新，重启生效';
              btnInstall.disabled = true;
              btnInstall.style.opacity = '0.55';
              btnLater.textContent = '关闭';
              break;
            }
            case 'error': {
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              status.textContent = p.error ? `安装失败：${p.error}` : '安装失败';
              break;
            }
            default:
              // idle：install 还没真正开始，继续轮询。
          }
        })
        .catch((e: unknown) => {
          // 卡③ 扩展（P1 缺陷卡）：progress 拒绝值（如 ACL 拒绝串）同样留痕，不静默。
          if (typeof e === 'string' && e.length > 0) console.debug('[StudioUI] updater_progress rejected:', e);
          else if (e instanceof Error && e.message) console.debug('[StudioUI] updater_progress rejected:', e.message);
        });
    }, 500);
  };

  btnInstall.addEventListener('click', () => {
    status.textContent = '正在准备下载…';
    void Promise.resolve(internals.invoke?.('updater_install'))
      .then(() => {
        if (disposed) return;
        // `{ started: false }` = 已有安装进行中（幂等门）→ 继续轮询即可。
        pollProgress();
      })
      .catch((e: unknown) => {
        if (disposed) return;
        // 卡③ 扩展：拒绝原因（如 ACL 拒绝串）留痕，可见文案不变。
        if (typeof e === 'string' && e.length > 0) console.debug('[StudioUI] updater_install rejected:', e);
        else if (e instanceof Error && e.message) console.debug('[StudioUI] updater_install rejected:', e.message);
        status.textContent = '启动更新失败';
      });
  });
  btnLater.addEventListener('click', () => {
    skipUpdateVersion(info.version);
    close();
  });

  return { close, root };
}
