import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TD-04（发版阻断）：宿主「资源根」（resource root）解析。
 *
 * 背景：旧实现里宿主是 `node ./node_modules/tsx/dist/cli.mjs src/api/main.ts` 直连，
 *   所有仓库内资源路径都靠 `path.resolve(dirname(import.meta.url), '../..')` 反推仓库根。
 *   开发树里这个推导恰好成立（入口在 `src/api/`），**安装版不成立**——入口被打包成
 *   单文件后 `import.meta.url` 指向安装目录里的 `host/main.mjs`，反推出来的「仓库根」
 *   是安装目录的父目录，资源全部找不到。
 *
 * 契约：
 *   1. `STUDIO_RESOURCE_ROOT` 存在 → 用它（Tauri 侧传 `resource_dir()`，安装版与
 *      开发树**目录结构同构**：`<res>/src/ui/agent.html`、`<res>/dist/agent-panel.js`）。
 *   2. 不存在 → 回退 `import.meta.url` 上溯两级（= 开发树里的仓库根，保持旧行为不变）。
 *
 * 纯函数：不碰 fs、不读环境变量对象本身，方便单测。
 */

/** 宿主运行期依赖的仓库内静态资源（相对资源根）。 */
export const RESOURCE_FILES = [
  path.join('src', 'ui', 'agent.html'),
  path.join('src', 'ui', 'agent.css'),
  path.join('src', 'ui', 'agent.webmanifest'),
  path.join('src', 'ui', 'agent-sw.js'),
  path.join('src', 'ui', 'icon-192.png'),
  path.join('src', 'ui', 'icon-512.png'),
  path.join('dist', 'agent-panel.js'),
] as const;

/**
 * 解析资源根。
 *
 * @param env 进程环境（只读 `STUDIO_RESOURCE_ROOT`）
 * @param moduleUrl 调用方模块的 `import.meta.url`（用于无环境变量时回退推导）
 */
export function resolveResourceRoot(
  env: { STUDIO_RESOURCE_ROOT?: string | undefined },
  moduleUrl: string,
): string {
  const raw = (env.STUDIO_RESOURCE_ROOT ?? '').trim();
  if (raw.length > 0) return path.resolve(raw);
  // 开发树回退：入口在 src/api/ → 上溯两级 = 仓库根。
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..');
}

/**
 * 资源根体检：列出缺失的静态资源。
 *
 * 存在的意义是**把「安装版起不来」从「页面 500 / 白屏」变成一行明确日志**：
 * 资源根指错时不必再猜是打包漏了还是路径解析错了。
 */
export function missingResourceFiles(
  resourceRoot: string,
  exists: (absolutePath: string) => boolean,
): string[] {
  return RESOURCE_FILES.filter((rel) => !exists(path.join(resourceRoot, rel))).map((rel) =>
    rel.split(path.sep).join('/'),
  );
}

/** 资源根无效时的诊断文案（打印到 stderr，给用户看）。 */
export function resourceRootDiagnostics(resourceRoot: string, missing: string[]): string {
  if (missing.length === 0) return '';
  return [
    `[deepseek-studio] 资源根无效：${resourceRoot}`,
    `[deepseek-studio] 缺失静态资源：${missing.join('、')}`,
    '[deepseek-studio] 安装版应由 Tauri 主进程传入 STUDIO_RESOURCE_ROOT（Tauri resource_dir()）；',
    '[deepseek-studio] 缺失时 /agent 面板会 404，但本地 API 仍可用。',
  ].join('\n');
}
