// W1：Workbench 真入口源码断言（node 环境，不拉起 Tauri/GUI）。
// 只读源码文本核对：Rust 命令真建窗、无第二托盘、菜单接线、handler 注册、capabilities 放行。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const mainRs = readFileSync(join(root, 'src-tauri/src/main.rs'), 'utf8');
const capabilities = readFileSync(join(root, 'src-tauri/capabilities/default.json'), 'utf8');

// 取 open_workbench 函数区间（到下一个顶层 fn 前），避免括号配平。
function openWorkbenchBody(src: string): string {
  const start = src.indexOf('fn open_workbench');
  const end = src.indexOf('fn focus_main_window', start);
  expect(start).toBeGreaterThanOrEqual(0);
  return src.slice(start, end > start ? end : src.length);
}

describe('W1 open_workbench 真建窗', () => {
  const body = openWorkbenchBody(mainRs);

  it('open_workbench 函数体含 WebviewWindowBuilder::new 与 "workbench"', () => {
    expect(body).toContain('WebviewWindowBuilder::new');
    expect(body).toContain('"workbench"');
  });

  it('已存在时 get_webview_window("workbench") + set_focus，不重复建窗', () => {
    expect(body).toContain('get_webview_window("workbench")');
    expect(body).toContain('set_focus');
  });
});

describe('W1 托盘唯一 + 菜单接线', () => {
  it('全文 TrayIconBuilder::with_id 只出现 1 次（无第二托盘）', () => {
    const matches = mainRs.match(/TrayIconBuilder::with_id/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('on_menu_event 不含 open-workbench（托盘只保留 show/hide/quit），但兼容命令仍存在', () => {
    // 方案 A：托盘菜单已简化为 show / hide / quit，不再暴露 open-workbench。
    // 函数 open_workbench 保留给兼容/诊断调用（generate_handler! 已注册）。
    expect(mainRs).not.toContain('"open-workbench"');
    // 兼容命令存在：函数定义 + handler 注册
    expect(mainRs).toContain('fn open_workbench(');
    expect(mainRs).toMatch(/generate_handler!\[.*open_workbench/s);
    // 托盘菜单只应有 show / hide / quit
    expect(mainRs).toContain('MenuItemBuilder::with_id("show"');
    expect(mainRs).toContain('MenuItemBuilder::with_id("hide"');
    expect(mainRs).toContain('MenuItemBuilder::with_id("quit"');
  });

  it('main.rs 含 MenuBuilder 或 MenuItemBuilder', () => {
    expect(mainRs.includes('MenuBuilder') || mainRs.includes('MenuItemBuilder')).toBe(true);
  });
});

describe('W1 handler 注册与 capabilities', () => {
  it('generate_handler! 含 open_workbench 与 focus_main_window', () => {
    const handler = mainRs.match(/generate_handler!\[([^\]]+)\]/)?.[1] ?? '';
    expect(handler).toContain('open_workbench');
    expect(handler).toContain('focus_main_window');
  });

  it('capabilities 的 windows 含 workbench', () => {
    const parsed = JSON.parse(capabilities) as { windows: string[] };
    expect(parsed.windows).toContain('main');
    expect(parsed.windows).toContain('workbench');
  });
});
