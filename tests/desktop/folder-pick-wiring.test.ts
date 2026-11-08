/**
 * `folder.pick` 工具 → 宿主原生目录选择器 接线（#38，PM-LOG L65/L68 2026-11-05 裁定）
 *
 * 裁定口径（三条负控，本文件逐条覆盖）：
 *   ① env 优先：`STUDIO_PICK_FOLDER` 命中 ⇒ 直接用，**不弹框**（既有自动化/测试口径不变）；
 *   ② env 未设（或指向不存在的路径）⇒ 回落 `pickFolderViaDialog()`；
 *   ③ 两者都拿不到（用户取消 / 180s 超时 / 对话框不可用）⇒ `ok:false`，不崩、不静默成功。
 *
 * 为什么 mock `folder-picker`：真实实现会 `spawn('powershell.exe', …)` 弹 GUI 模态、最长阻塞 180s，
 * 在单测里既跑不了也不该弹。本文件把 `pickFolderViaDialog` 替换成桩，**生产源文件零改动**
 * （台账 81 枚：负控不许改生产源再靠"还原"）。
 *
 * 口径边界：本文件证明的是**接线**（工具是否调用选择器、如何处置返回值），
 * **不是**"装版现场真能弹出对话框"——后者只有真机取证能给（#38 验收项）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { pickMock } = vi.hoisted(() => ({ pickMock: vi.fn() }));

vi.mock('../../src/host/folder-picker', () => ({
  FOLDER_PICKER_TIMEOUT_MS: 180_000,
  pickFolderViaDialog: pickMock,
}));

const { createDesktopHost } = await import('../../src/host/desktop-host');
type DesktopHost = Awaited<ReturnType<typeof createDesktopHost>> extends never ? never : ReturnType<typeof createDesktopHost>;

const running: DesktopHost[] = [];
const tmpDirs: string[] = [];

async function startHost(): Promise<DesktopHost> {
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    policyMode: 'auto',
  });
  await host.start();
  running.push(host);
  return host;
}

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-pick-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (running.length) {
    const h = running.pop();
    try {
      await h?.stop();
    } catch {
      /* 已停止 */
    }
  }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try {
      if (d) rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  pickMock.mockReset();
  delete process.env.STUDIO_PICK_FOLDER;
});

describe('folder.pick → 原生选择器接线（env 优先 / 未设回落 / 两无不崩）', () => {
  it('负控①-env 优先：STUDIO_PICK_FOLDER 命中即用，且**不调用**原生选择器（不弹框）', async () => {
    const dir = tmpDir();
    process.env.STUDIO_PICK_FOLDER = dir;
    const host = await startHost();
    const r = await host.invokeTool('folder.pick', {});
    expect(r.ok).toBe(true);
    expect((r.data as { path?: string }).path).toBe(dir);
    // 关键负控：env 命中时若仍去弹框 ⇒ 本行必红
    expect(pickMock).not.toHaveBeenCalled();
  });

  it('负控②-未设回落：无 env ⇒ 调用原生选择器，并原样回传其返回路径', async () => {
    const dir = tmpDir();
    pickMock.mockResolvedValue(dir);
    const host = await startHost();
    const r = await host.invokeTool('folder.pick', {});
    expect(pickMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect((r.data as { path?: string }).path).toBe(dir);
  });

  it('env 指向不存在的路径 ⇒ 不报错、回落原生选择器（env 只是优先，不是唯一）', async () => {
    const dir = tmpDir();
    process.env.STUDIO_PICK_FOLDER = path.join(dir, 'not-exist-subdir');
    expect(existsSync(process.env.STUDIO_PICK_FOLDER)).toBe(false);
    pickMock.mockResolvedValue(dir);
    const host = await startHost();
    const r = await host.invokeTool('folder.pick', {});
    expect(pickMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect((r.data as { path?: string }).path).toBe(dir);
  });

  it('负控③-两无：用户取消 / 超时 / 不可用（选择器返 null）⇒ ok:false，不崩、不静默成功', async () => {
    pickMock.mockResolvedValue(null);
    const host = await startHost();
    const r = await host.invokeTool('folder.pick', {});
    expect(r.ok).toBe(false);
    const err = String(r.reason ?? '');
    // 说对机制：是"没拿到"，不是"没接入"
    expect(err).toContain('未取到');
    // 可执行下一步不许丢
    expect(err).toContain('绝对路径');
    // 方向锁：旧的不实陈述不得回流（"未接入"在 #38 之后已不成立）
    expect(err).not.toContain('未接入');
    expect(err).not.toContain('没有原生目录选择器');
    expect(err).not.toContain('requires Tauri dialog');
  });

  it('选择器抛异常也不许把工具打崩（宿主侧 fail-closed 返 ok:false）', async () => {
    pickMock.mockRejectedValue(new Error('spawn failed'));
    const host = await startHost();
    const r = await host.invokeTool('folder.pick', {});
    expect(r.ok).toBe(false);
  });
});
