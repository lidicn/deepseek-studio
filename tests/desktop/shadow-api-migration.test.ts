// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const textOf = (abs: string): string => readFileSync(abs, 'utf8');

describe('旧 Shadow API 迁移清单与源码一致（W5）', () => {
  const docPath = resolve(__dirname, '../../docs/前端开发计划/旧Shadow迁移清单-20261020.md');

  it('清单文档存在且含三态标签', () => {
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    expect(doc).toContain('deprecated-unreachable');
    expect(doc).toContain('retained-with-reason');
  });

  it('studio-ui-install 无任何外部 import（deprecated-unreachable）', () => {
    const re = /from\s+['"]\.{1,2}\/.*studio-ui-install['"]|require\(.*studio-ui-install/;
    const importers = files.filter((f) => !f.endsWith('studio-ui-install.ts') && re.test(textOf(f)));
    expect(importers).toHaveLength(0);
  });

  it('7 个旧面板仅被 studio-ui-install 引用（仅统计 import 语句）', () => {
    const panels = [
      'studio-sidebar',
      'studio-input-bar',
      'studio-settings-panel',
      'studio-project-picker',
      'studio-skills-panel',
      'studio-mcp-dialog',
      'studio-right-sidebar',
    ];
    for (const panel of panels) {
      // 只认相对 import：from './<panel>'，排除 CSS 类名、注释、选择器命中
      const re = new RegExp(`from ['"]\\./${panel}['"]`);
      const importers = files.filter((f) => !f.endsWith(`${panel}.ts`) && re.test(textOf(f)));
      expect(importers.map((f) => f.replace(SRC, '')), panel).toHaveLength(1);
      expect(importers[0]).toContain('studio-ui-install.ts');
    }
  });

  it('studio-chat-room 被 entry.ts 直接 import（retained-with-reason）', () => {
    const entry = textOf(join(SRC, 'desktop/entry.ts'));
    expect(entry).toContain("from '../ui/studio-chat-room'");
  });

  it('真 Shadow mountShadowRoot 仅被 focus-mode 使用（定义在 shadow-root）', () => {
    const users = files.filter((f) => textOf(f).includes('mountShadowRoot('));
    const names = users.map((f) => f.replace(SRC, ''));
    expect(names.some((n) => n.includes('focus-mode.ts'))).toBe(true);
    expect(names.every((n) => n.includes('shadow-root.ts') || n.includes('focus-mode.ts'))).toBe(true);
  });

  it('清单把 chat-room 标 retained、install 标 unreachable', () => {
    const doc = readFileSync(docPath, 'utf8');
    expect(doc).toMatch(/studio-chat-room\.ts \| retained-with-reason/);
    expect(doc).toMatch(/studio-ui-install\.ts \| deprecated-unreachable/);
  });
});
