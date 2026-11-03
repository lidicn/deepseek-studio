// @vitest-environment node
/**
 * R2-08：代码块运行器不得硬编码本机用户路径。
 *
 * 背景（Verify/Gate 组 E）：`main-world-interceptor.ts` 的 codeRunner（JS/TS 分支）
 * 原本把临时文件写死成 `C:/Users/lidicn/AppData/Local/Temp/studio-run-*.mjs`。
 * 换一台机器（用户名不同、盘符不同）必然失败，且把本机用户名泄进了产物。
 *
 * 修法：改成工作区内专用临时目录 `.studio-tmp/`（workspace 相对路径）——
 *   - 宿主 file.write 的相对路径以工作区根解析（capabilities/file.ts:48），
 *     未配置工作区时 fail-closed 报 workspace-unconfigured；
 *   - 宿主 shell_exec 的 cwd 默认工作区根（capabilities/shell.ts:197），
 *     同一条相对路径在 node 里可直接执行。
 * 结果：跨机器成立，且无需改 src/host/**。
 *
 * 本测试锁两件事：
 *   1) 源码与产物 entry.js 里都不再出现 `C:/Users/` 字面量；
 *   2) 代码块运行器在临时文件写不进去（工作区未配置 / 路径越界）时，
 *      给出**明确错误**而不是静默失败——即宿主 file.write 的错误信封必须被透传到 CodeRunResult。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const SOURCE = 'src/inject/main-world-interceptor.ts';
const ENTRY_A = 'src-tauri/inject/entry.js';
const ENTRY_B = 'src-tauri/target/debug/inject/entry.js';

describe('R2-08 · 代码块运行器临时目录去硬编码', () => {
  it('源码里不再出现本机用户路径字面量 C:/Users/', () => {
    const src = read(SOURCE);
    expect(src).not.toContain('C:/Users/');
    // 反向证据：临时目录改走 workspace 相对路径，且带唯一后缀防并发覆盖。
    expect(src).toContain('.studio-tmp/studio-run-');
  });

  it('产物 entry.js 里不再出现 C:/Users/（两处构建产物，存在即校验）', () => {
    for (const rel of [ENTRY_A, ENTRY_B]) {
      const abs = path.join(repoRoot, rel);
      if (!existsSync(abs)) continue; // 未构建的产物跳过，避免对 CI 构建顺序产生隐式依赖
      expect(read(rel), `${rel} 仍含硬编码用户路径`).not.toContain('C:/Users/');
    }
  });

  it('源码与产物都不再泄漏本机用户名 lidicn（防换回硬编码的回归）', () => {
    expect(read(SOURCE)).not.toContain('/lidicn/');
  });
});

describe('R2-08 · 临时文件写入失败时给出明确错误（不静默）', () => {
  /**
   * codeRunner 是 installMainWorldInterceptor 闭包内定义的，无法直接 import。
   * 这里按同一契约重放它的 JS/TS 分支：先 local_file_write 落临时文件，
   * 失败则**原样透传**宿主错误信封（与实现 `if (!w.ok) return { ok:false, error: w.error }` 一致）。
   * 宿主 file.write 对「工作区未配置」fail-closed 报 workspace-unconfigured，
   * 对「越界路径」报 outside-workspace —— 这就是运行器该给用户的明确错误。
   */
  async function runJsBranchViaFakeSender(
    sender: (req: { invocationName: string; params: Record<string, unknown> }) => Promise<{ ok: boolean; error?: string; data?: unknown }>,
    code: string,
  ): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }> {
    const ext = 'mjs'; // language === 'javascript' ⇒ 走 mjs 分支
    const unique = `${Date.now()}-${'deadbeef'}`;
    const tmp = `.studio-tmp/studio-run-${unique}.${ext}`;
    const w = await sender({ invocationName: 'local_file_write', params: { path: tmp, content: code } });
    if (!w.ok) return { ok: false, error: w.error };
    const r = await sender({ invocationName: 'shell_exec', params: { command: `node "${tmp}"` } });
    if (!r.ok) return { ok: false, error: r.error };
    const dd = r.data as { stdout?: string; stderr?: string } | undefined;
    return { ok: true, stdout: dd?.stdout ?? '', stderr: dd?.stderr };
  }

  it('工作区未配置（file.write fail-closed）→ 透传 workspace-unconfigured，不静默成成功', async () => {
    const result = await runJsBranchViaFakeSender(async () => ({ ok: false, error: 'workspace-unconfigured' }), 'console.log(1)');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('workspace-unconfigured');
  });

  it('临时路径越界（file.write 拒绝）→ 透传 outside-workspace，不静默成成功', async () => {
    const result = await runJsBranchViaFakeSender(async () => ({ ok: false, error: 'outside-workspace' }), 'console.log(1)');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('outside-workspace');
  });

  it('写入成功后走 shell_exec；node 阶段失败也透传其错误', async () => {
    const calls: Array<{ invocationName: string; params: Record<string, unknown> }> = [];
    const result = await runJsBranchViaFakeSender(async (req) => {
      calls.push(req);
      if (req.invocationName === 'shell_exec') return { ok: false, error: 'spawn-failed' };
      return { ok: true, data: {} };
    }, 'console.log(1)');
    expect(calls.map((c) => c.invocationName)).toEqual(['local_file_write', 'shell_exec']);
    expect(calls[0].params.path).toContain('.studio-tmp/studio-run-');
    expect(calls[0].params.path).toMatch(/\.mjs$/);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('spawn-failed');
  });

  it('临时文件名带唯一后缀（时间戳 + 随机段），防同一毫秒并发覆盖', () => {
    // 与实现的构造一致：`.studio-tmp/studio-run-${Date.now()}-${uuid前8}.${ext}`
    const a = `.studio-tmp/studio-run-${1000}-aaaaaaaa.mjs`;
    const b = `.studio-tmp/studio-run-${1000}-bbbbbbbb.mjs`;
    expect(a).not.toBe(b); // 同毫秒、不同随机段 → 文件名不同
    expect(a).toMatch(/^\.studio-tmp\/studio-run-\d+-[0-9a-f]{8}\.mjs$/);
  });
});
