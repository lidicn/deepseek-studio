/**
 * tests/desktop/tools-resource-contract-guard.test.ts — resource-contract-guard 正负控回归。
 *
 * 判据（裁定，20261106）：main.ts 里 resourceRoot 派生的字面量 join 必须全部出现在
 * tauri.conf.json bundle.resources——缺条目 = dev 能跑、装版 500（与 P0 竞态同族）。
 *
 * 先红后绿（真实缺陷上的红）：当前树红 3 条（mcp-settings 壳三件，main.ts:126-128）；
 * UI 把三行加进 bundle.resources 后自动转绿。装置自检两条（join 条数 ≥10、resources >0）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'audit', 'resource-contract-guard.ts');

/** 在临时目录造一个最小契约仓：main.ts（n 条 join）+ tauri.conf.json（resources）。 */
function makeTempRepo(joinRels: string[], resourceTargets: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcg-repo-'));
  fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src-tauri'), { recursive: true });
  const joinLines = joinRels
    .map((r) => `  path.join(resourceRoot, ${r.split('/').map((s) => `'${s}'`).join(', ')}),`)
    .join('\n');
  fs.writeFileSync(
    path.join(dir, 'src', 'api', 'main.ts'),
    `const resourceRoot = resolveResourceRoot(process.env, import.meta.url);\n${joinLines}\n`,
  );
  const resources: Record<string, string> = {};
  for (const t of resourceTargets) resources[`../${t}`] = t;
  fs.writeFileSync(
    path.join(dir, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({ bundle: { resources } }, null, 2),
  );
  return dir;
}

function runGuard(rootPath: string): { code: number; output: string } {
  try {
    const stdout = execSync(`npx tsx "${SCRIPT}" --root "${rootPath}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('tools/audit/resource-contract-guard', () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const p of scratch) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('本仓：守卫可运行且产出一致（当前先红：点名 3 条 mcp-settings；UI 修复后自动转绿）', () => {
    const r = runGuard(ROOT);
    // 两态都合法：红（UI 未加三行）/ 绿（UI 已加）。但任何一态都不得报装置错误。
    expect([0, 1]).toContain(r.code);
    expect(r.output).not.toContain('ERROR');
    if (r.code === 1) {
      // 先红态：必须点名已知缺口（mcp-settings 壳三件），不得跑偏到别的路径
      expect(r.output).toContain('FAIL: 3 条');
      expect(r.output).toContain('src/ui/mcp-settings.html');
      expect(r.output).toContain('dist/mcp-settings-panel.js');
      expect(r.output).toContain('src/ui/mcp-settings.css');
    } else {
      expect(r.output).toContain('PASS');
    }
  });

  it('绿：10 条 join 全在 bundle.resources → exit 0（UI 加三行后的预期形态）', () => {
    const rels = [
      'src/ui/agent.html', 'dist/agent-panel.js', 'src/ui/agent.css', 'src/ui/agent.webmanifest',
      'src/ui/agent-sw.js', 'src/ui/icon-192.png', 'src/ui/icon-512.png',
      'src/ui/mcp-settings.html', 'dist/mcp-settings-panel.js', 'src/ui/mcp-settings.css',
    ];
    const dir = makeTempRepo(rels, rels);
    scratch.push(dir);
    const r = runGuard(dir);
    expect(r.code, `应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(r.output).toContain('PASS');
    expect(r.output).toContain('10 条');
  });

  it('装置自检①：join 条数 < 10 → exit 1 + 报条数（防路径写错导致永远绿）', () => {
    const rels = ['src/ui/agent.html', 'src/ui/agent.css'];
    const dir = makeTempRepo(rels, rels);
    scratch.push(dir);
    const r = runGuard(dir);
    expect(r.code).toBe(1);
    expect(r.output).toContain('条数 = 2');
    expect(r.output).toContain('请核');
  });

  it('装置自检②：bundle.resources 解析出 0 条 → exit 1 + 报结构变化', () => {
    const rels = [
      'src/ui/agent.html', 'dist/agent-panel.js', 'src/ui/agent.css', 'src/ui/agent.webmanifest',
      'src/ui/agent-sw.js', 'src/ui/icon-192.png', 'src/ui/icon-512.png',
      'src/ui/mcp-settings.html', 'dist/mcp-settings-panel.js', 'src/ui/mcp-settings.css',
    ];
    const dir = makeTempRepo(rels, []);
    scratch.push(dir);
    const r = runGuard(dir);
    expect(r.code).toBe(1);
    expect(r.output).toContain('bundle.resources 解析出 0 条');
  });
});
