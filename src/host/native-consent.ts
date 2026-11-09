/**
 * R2-01：宿主原生确认框（Windows MessageBox，node 侧实现）——**卡 J 起降为降级通道**。
 *
 * 背景：consent 决议原走页端通道（页面回传 consent-decision），被约束方（页面/模型）
 * 可伪造。R2-01 当时的做法是：高风险授权让决议**来自页面之外**——本模块用 node 侧直接弹
 * 系统原生 MessageBox（powershell + System.Windows.Forms），页面完全无参与。
 *
 * **2026-11-09 卡 J 起语义变更（PM 裁定 A′，出资人 11-08 拍板「不要逐次弹原生框」）**：
 *   - **越界（outside）**：任何档位都**不给页面决议权**，由宿主侧确认 ⇒ 今天就是本模块的原生框。
 *     R2-01 的不变量「**越界不得由页面自答**」**仍然活着**（提示注入最想拿的就是这一格）。
 *     C″（Rust 自绘宿主窗口）待出资人拍板；获批后只替换 desktop-host 里 `askHostSide` 的实现。
 *   - **非越界的高风险**：主路径改为**页内模态**（`hub.requestConsent`，带一次性 nonce）；
 *     ⇒ R2-01 原设计里「**高风险（除越界外）决议不得由页面自答**」**已作废**，台账有记录。
 *   - 本模块在非越界路径上只在**页内不可用**时作为**降级**被调用，且 `ensureConsent` 必须把这次
 *     降级写进审计（`degraded`），不得静默。
 *   - 补偿防线：nonce 一次性消费 + 常数时间比对 + 真实手势（isTrusted）+ 渲染失败 fail-closed。
 *
 * 架构说明（为什么在 node 而非 tauri 主进程）：
 *   - host(node) 跑在 sidecar 进程里，与 tauri 主进程之间**没有 node→tauri 的上行 RPC**；
 *     从 tauri 弹框需新建跨进程通道（高风险）。
 *   - node 侧直接弹系统框零跨进程，且「宿主」本身就是 node——这才是「宿主侧原生框」。
 *   - `desktop-host` 仍保留 `options.nativeConsent` 注入点：将来 tauri 若要接管，
 *     注入自己的实现即可覆盖本默认实现。
 *
 * 取舍：MessageBox 是**阻塞式**系统框（在 node 里异步 spawn，不阻塞宿主事件循环）。
 * 按钮 = 是(allow-once) / 否(deny)。长时效授权（session/conversation）在原生框里**不给**，
 * 只给 allow-once/deny——长时效必须回页端模态走 nonce（见 desktop-host 的 allowedDecisions 逻辑）。
 */
import { execFile } from 'node:child_process';

export interface NativeConsentPrompt {
  readonly tool: string;
  readonly summary: string;
  readonly riskReason: string;
  readonly allowedDecisions: readonly string[];
}

export interface NativeConsentOutcome {
  /** 用户选择：allow-once / deny。null 表示无法弹框（环境不支持/失败）。 */
  readonly decision: 'allow-once' | 'deny' | null;
  /** 是否真的弹了框（用于审计区分「用户拒绝」与「弹不出→降级」）。 */
  readonly shown: boolean;
  readonly reason?: string;
}

/** 把展示文本转义成 PowerShell 单引号字符串字面量（内部单引号翻倍）。 */
function psQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 弹原生确认框并等待用户选择。仅 Windows 用 MessageBox；其它平台返回 shown=false。
 *
 * 非阻塞宿主事件循环：execFile 异步，返回 Promise。
 */
export function showNativeConsent(prompt: NativeConsentPrompt): Promise<NativeConsentOutcome> {
  if (process.platform !== 'win32') {
    return Promise.resolve({ decision: null, shown: false, reason: 'non-windows' });
  }
  // MessageBox 只有 Yes/No；长时效不在原生框（上层 allowedDecisions 已剥离）。
  const toolLine = prompt.tool;
  const summaryLine = prompt.summary || '(无可展示参数)';
  const riskLine = prompt.riskReason;
  const text = `工具：${toolLine}\n操作：${summaryLine}\n风险：${riskLine}\n\n是否允许本次执行？`;
  const title = 'DeepSeek++ Studio · 需要确认';
  // MessageBoxButtons.YesNo → 用户点「是」= allow-once，点「否」= deny。
  const script =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    `$r=[System.Windows.Forms.MessageBox]::Show(${psQuote(text)},${psQuote(title)},` +
    '[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning);' +
    'if($r -eq [System.Windows.Forms.DialogResult]::Yes){Write-Output "YES"}else{Write-Output "NO"}';

  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 120_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ decision: null, shown: false, reason: `spawn-error: ${error.message}` });
          return;
        }
        const out = String(stdout).trim();
        if (out.includes('YES')) resolve({ decision: 'allow-once', shown: true });
        else resolve({ decision: 'deny', shown: true });
      },
    );
  });
}
