/**
 * updater 调用点回归断言（发布后 Verify 确证的缺陷：包/签/端点全就绪，但全仓 0 处 check_update
 * → 用户永远收不到更新提示）。
 *
 * 本测试守的是「调用点存在」这件事本身，而不是某个函数行为：
 *   ① Rust 侧必须注册三个 command（updater_check / updater_install / updater_progress）
 *      并在启动路径触发一次自动检查；
 *   ② 页端必须真的有调用（src/desktop 或 src/ui 里出现 invoke('updater_check')）。
 *
 * 负控：把任一侧的调用点删掉 → 本文件必红。这正是「无调用点→红」的落地。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

/** 收集 src/desktop 与 src/ui 下所有 .ts 源码（页端可调用面）。 */
function pageSources(): string {
  const dirs = ['src/desktop', 'src/ui'];
  const out: string[] = [];
  for (const d of dirs) {
    const abs = path.join(repoRoot, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs, { recursive: true }) as string[]) {
      if (f.endsWith('.ts')) out.push(read(path.join(d, f)));
    }
  }
  return out.join('\n');
}

describe('updater 调用点（缺陷回归：用户收不到更新提示）', () => {
  it('Rust 侧注册了三个 updater command', () => {
    const main = read('src-tauri/src/main.rs');
    expect(main).toContain('mod updater;');
    for (const cmd of ['updater::updater_check', 'updater::updater_install', 'updater::updater_progress']) {
      expect(main, `generate_handler 缺 ${cmd}`).toContain(cmd);
    }
  });

  it('启动路径触发了自动检查（每次运行至多一次）', () => {
    const main = read('src-tauri/src/main.rs');
    expect(main).toContain('updater::init_state');
    expect(main).toMatch(/spawn_startup_check/);
    // 实现侧确认延迟 60s（不与启动抢带宽）
    const updater = read('src-tauri/src/updater.rs');
    expect(updater).toMatch(/from_secs\(60\)/);
  });

  it('fail-safe：检查失败/无更新都返回 None（不把网络错误当更新提示）', () => {
    const updater = read('src-tauri/src/updater.rs');
    // Err 分支必须返回 None 并打 fail-safe 日志，而不是 panic 或返回错误给页面
    expect(updater).toMatch(/updater check failed \(fail-safe/);
    expect(updater).toMatch(/Ok\(None\) => None/);
  });

  it('页端真的调用了 updater_check / updater_install（不是只有 Rust 侧空转）', () => {
    const page = pageSources();
    expect(page, "页端无 invoke('updater_check') —— 等于用户收不到更新提示").toMatch(
      /invoke\(\s*['"]updater_check['"]/,
    );
    expect(page).toMatch(/invoke\(\s*['"]updater_install['"]/);
  });
});
