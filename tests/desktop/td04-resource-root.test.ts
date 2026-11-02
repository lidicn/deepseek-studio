import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  RESOURCE_FILES,
  resolveResourceRoot,
  missingResourceFiles,
  resourceRootDiagnostics,
} from '../../src/api/resource-root';

/**
 * TD-04：资源根解析的护栏。
 *
 * 判据（对应「安装版起不来宿主」这个发版阻断）：
 *   ① STUDIO_RESOURCE_ROOT 优先于 import.meta.url 推导 —— 安装版入口在安装目录里，
 *      靠 import.meta.url 反推必然错，必须由 Tauri 传 resource_dir()。
 *   ② 无环境变量时回退到开发树仓库根 —— 旧行为不变，dev/tsx 路径不被打破。
 *   ③ 资源根指错时必须**说出缺什么**（不是白屏、不是 500）。
 */
describe('TD-04 资源根解析', () => {
  const devModuleUrl = 'file:///E:/NAS/deepseek-studio/src/api/main.ts';

  it('① 有 STUDIO_RESOURCE_ROOT 时用它，不看 import.meta.url', () => {
    const root = resolveResourceRoot(
      { STUDIO_RESOURCE_ROOT: 'C:/Program Files/DeepSeek++ Studio/resources' },
      devModuleUrl,
    );
    expect(root).toBe(path.resolve('C:/Program Files/DeepSeek++ Studio/resources'));
  });

  it('② 无环境变量时回退开发树仓库根（入口在 src/api/ → 上溯两级）', () => {
    expect(resolveResourceRoot({}, devModuleUrl)).toBe(path.resolve('E:/NAS/deepseek-studio'));
  });

  it('② 环境变量为空串/纯空白 ⇒ 等同未设置', () => {
    expect(resolveResourceRoot({ STUDIO_RESOURCE_ROOT: '' }, devModuleUrl)).toBe(
      path.resolve('E:/NAS/deepseek-studio'),
    );
    expect(resolveResourceRoot({ STUDIO_RESOURCE_ROOT: '   ' }, devModuleUrl)).toBe(
      path.resolve('E:/NAS/deepseek-studio'),
    );
  });

  it('② 环境变量带前后空白 ⇒ trim 后使用', () => {
    const root = resolveResourceRoot(
      { STUDIO_RESOURCE_ROOT: '  D:/res/root  ' },
      devModuleUrl,
    );
    expect(root).toBe(path.resolve('D:/res/root'));
  });

  it('① 相对路径环境变量按 cwd 绝对化（不产生相对根）', () => {
    const root = resolveResourceRoot({ STUDIO_RESOURCE_ROOT: 'res/root' }, devModuleUrl);
    expect(path.isAbsolute(root)).toBe(true);
  });

  it('③ 资源齐全时无缺失、无诊断文案', () => {
    const missing = missingResourceFiles('C:/res', () => true);
    expect(missing).toEqual([]);
    expect(resourceRootDiagnostics('C:/res', missing)).toBe('');
  });

  it('③ 资源缺失时逐个点名，且诊断文案带资源根与全部缺失项', () => {
    // 只有 agent-panel.js 存在 ⇒ 其余 6 个缺失（存在的不该出现在 missing 里）
    const missing = missingResourceFiles('C:/res', (p) => p.endsWith('agent-panel.js'));
    expect(missing).not.toContain('dist/agent-panel.js');
    expect(missing).toContain('src/ui/agent.html');
    expect(missing.length).toBe(RESOURCE_FILES.length - 1);
    const diag = resourceRootDiagnostics('C:/res', missing);
    expect(diag).toContain('C:/res');
    expect(diag).toContain('src/ui/agent.html');
    expect(diag).toContain('STUDIO_RESOURCE_ROOT');
  });

  it('负控：资源根指错时必须被点名（否则就是「白屏但没人知道」）', () => {
    // 断言语义本身：缺 1 个就要报 1 个，不允许「只报第一个」或「全报都不报」。
    const missing = missingResourceFiles('C:/res', () => false);
    expect(missing.length).toBe(RESOURCE_FILES.length);
    expect(new Set(missing).size).toBe(RESOURCE_FILES.length);
  });
});
