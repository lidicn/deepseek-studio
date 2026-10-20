/**
 * Workbench 主题（§10.4）：把 design-tokens 的 light/dark 转成 --studio-* CSS 变量，
 * 写到 document.documentElement.style。Workbench 走 Light DOM，不进 Shadow。
 */
import { tokensToCssVars } from '../design-tokens';

/** 主题名。与 host-theme-adapter.StudioTheme 同值域，此处为 UI 侧权威命名。 */
export type WorkbenchTheme = 'light' | 'dark';

/**
 * 应用主题：解析 tokensToCssVars 产出的 `key: value; ...` 声明并逐条 setProperty。
 * 不覆盖未在 token 表内的既有变量。
 */
export function applyWorkbenchTheme(theme: WorkbenchTheme): void {
  const declarations = tokensToCssVars(theme);
  for (const raw of declarations.split(';')) {
    const colon = raw.indexOf(':');
    if (colon <= 0) continue;
    const key = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (key && value) {
      document.documentElement.style.setProperty(key, value);
    }
  }
}
