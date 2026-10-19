// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('W6 policy 词表对齐共享契约 + dompurify 精确锁定', () => {
  it('package.json dompurify 精确锁 3.4.17，无 ^ 或 ~', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies.dompurify).toBe('3.4.17');
    expect(pkg.dependencies.dompurify).not.toMatch(/[\^~]/);
    const lock = read('package-lock.json');
    expect(lock).toContain('"dompurify": "3.4.17"');
  });

  it('共享契约 PANEL_POLICY_MODES = workspace/auto/full，含 workspace、不含 ask', () => {
    const contract = read('src/shared/policy-contract.ts');
    expect(contract).toMatch(/PANEL_POLICY_MODES\s*=\s*\[\s*'workspace'\s*,\s*'auto'\s*,\s*'full'\s*\]/);
    expect(contract).toContain("workspace: '仅工作区'");
    expect(contract).toContain("full: '完全放开'");
  });

  it('src/ui 不存在旧字面量强转 full|auto|ask', () => {
    const hits = walk(join(ROOT, 'src/ui')).filter((f) =>
      /'full' \| 'auto' \| 'ask'/.test(readFileSync(f, 'utf8')),
    );
    expect(hits).toHaveLength(0);
  });

  it('settings-panel 遍历 PANEL_POLICY_MODES、用 POLICY_MODE_LABELS，不硬编码 ask', () => {
    const src = read('src/ui/studio-settings-panel.ts');
    expect(src).toContain('PANEL_POLICY_MODES');
    expect(src).toContain('POLICY_MODE_LABELS');
    expect(src).not.toMatch(/['"]ask['"]/);
  });

  it('input-bar 档位派生自契约，无旧字面量强转', () => {
    const src = read('src/ui/studio-input-bar.ts');
    expect(src).toContain('PANEL_POLICY_MODES');
    expect(src).toContain('POLICY_MODE_LABELS');
    expect(src).not.toMatch(/'full' \| 'auto' \| 'ask'/);
  });

  it('studio-ui-core 的 UIState.policyMode 使用 PolicyMode 类型', () => {
    const src = read('src/ui/studio-ui-core.ts');
    expect(src).toContain("import type { PolicyMode } from '../shared/policy-contract'");
    expect(src).toMatch(/policyMode:\s*PolicyMode;/);
    expect(src).not.toMatch(/policyMode:\s*'full' \| 'auto' \| 'ask'/);
  });
});
