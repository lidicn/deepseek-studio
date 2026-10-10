/**
 * 原生目录选择对话框（M1「打开文件夹」）
 *
 * Windows 实现：PowerShell FolderBrowserDialog（TopMost 窗体，避免被 Tauri 窗口盖住）。
 * argv spawn、shell:false、有超时——与 shell 能力同一条安全红线。
 * 用户取消 / 超时 / spawn 失败一律返回 null（调用方保持原工作区不变）。
 */

import { spawn } from 'node:child_process';

export const FOLDER_PICKER_TIMEOUT_MS = 180_000;

const PS_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null; " +
  "$f = New-Object System.Windows.Forms.Form; " +
  "$f.TopMost = $true; " +
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
  "$d.Description = '选择智能体工作区（打开的目录即权限边界）'; " +
  "$r = $d.ShowDialog($f); " +
  "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }";

export interface FolderPickerDeps {
  /** 测试注入用：覆盖 spawn。 */
  spawnFn?: typeof spawn;
  timeoutMs?: number;
}

export function pickFolderViaDialog(deps: FolderPickerDeps = {}): Promise<string | null> {
  const spawnFn = deps.spawnFn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? FOLDER_PICKER_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', PS_SCRIPT], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }

    let out = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    child.stdout?.on('data', (buf: Buffer) => {
      out += buf.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const trimmed = out.trim();
      finish(trimmed.length > 0 ? trimmed : null);
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
  });
}
