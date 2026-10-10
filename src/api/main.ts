/**
 * 入口：由 Node 原型宿主（后续 v0.7 由 Tauri 主进程）拉起本地 HTTP API + 常驻授权方。
 *
 * 配置来源（优先级从高到低）：环境变量 DEEPSEEK_STUDIO_* > 本地配置文件 >
 * 自动生成（首次运行随机 token/secret 并落盘 ~/.config/deepseek-studio/config.json，权限 0600）。
 * 端口固定 8756（避开 DeskPilot 占用的 8765）。
 */

import { createDesktopHost } from '../host/desktop-host';
import { createWorkspace } from '../host/workspace';
import { DEFAULT_POLICY_MODE, isPolicyMode, POLICY_MODE_LABELS, type PolicyMode } from '../host/policy';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiConfig } from './types';

interface StoredConfig extends Partial<ApiConfig> {
  secret?: string;
  /** v0.5：工作区根（也可用环境变量 STUDIO_WORKSPACE_ROOT 覆盖）。 */
  workspaceRoot?: string;
  /** v0.5：命令审批档位 ask / auto / full（默认 ask）。 */
  policyMode?: string;
}
interface ResolvedConfig {
  config: ApiConfig;
  secret: string;
  workspaceRoot: string;
  policyMode: PolicyMode;
}

function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

function loadConfig(): ResolvedConfig {
  const cfgDir = path.join(os.homedir(), '.config', 'deepseek-studio');
  const cfgPath = path.join(cfgDir, 'config.json');
  let stored: StoredConfig = {};
  try {
    stored = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as StoredConfig;
  } catch {
    stored = {};
  }

  const token = process.env.DEEPSEEK_STUDIO_TOKEN ?? stored.token ?? randomToken();
  const secret = process.env.DEEPSEEK_STUDIO_SECRET ?? stored.secret ?? randomToken();
  const host = process.env.DEEPSEEK_STUDIO_HOST ?? stored.host ?? '127.0.0.1';
  const port = Number(process.env.DEEPSEEK_STUDIO_PORT ?? stored.port ?? 8756);

  // 缺失则生成并落盘（仅本地文件，0600；不回显 secret）。
  if (!stored.token || !stored.secret) {
    try {
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify({ host, port, token, secret }, null, 2), { mode: 0o600 });
    } catch (err) {
      // fail-open：持久化失败仍可运行（token/secret 仅本进程有效）。
      console.warn(
        `[deepseek-studio] 无法持久化配置到 ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // v0.5：工作区根与审批档位。档位非法值一律回落到 auto（fail-safe：宁可多问不可少问）。
  const workspaceRoot = process.env.STUDIO_WORKSPACE_ROOT ?? stored.workspaceRoot ?? '';
  const rawMode = process.env.STUDIO_POLICY_MODE ?? stored.policyMode ?? '';
  const policyMode: PolicyMode = isPolicyMode(rawMode) ? rawMode : DEFAULT_POLICY_MODE;

  return { config: { host, port, token }, secret, workspaceRoot, policyMode };
}

export async function main(): Promise<void> {
  const { config, secret, workspaceRoot, policyMode } = loadConfig();
  const workspace = workspaceRoot ? createWorkspace(workspaceRoot) : null;
  // M1 智能体面板静态资源（esbuild 产物：src/ui/agent.html + dist/agent-panel.js）
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const agentPage = {
    htmlPath: path.join(repoRoot, 'src', 'ui', 'agent.html'),
    jsPath: path.join(repoRoot, 'dist', 'agent-panel.js'),
    cssPath: path.join(repoRoot, 'src', 'ui', 'agent.css'),
  };
  const host = createDesktopHost({ config, secret, workspace, policyMode, agentPage });
  await host.start();
  console.log(`[deepseek-studio] 本地 HTTP API on ${host.url}`);
  console.log('[deepseek-studio] token 取自 DEEPSEEK_STUDIO_TOKEN 或 ~/.config/deepseek-studio/config.json');
  console.log(
    workspace
      ? `[deepseek-studio] 工作区: ${workspace.root}（区内自动放行，区外按策略）`
      : '[deepseek-studio] 工作区未配置 → file.* 能力不可用（请设 STUDIO_WORKSPACE_ROOT 或用户配置 workspaceRoot）',
  );
  console.log(`[deepseek-studio] 命令审批档位: ${POLICY_MODE_LABELS[policyMode]} (${policyMode})`);
}

// 进程直接运行时自启动。
// 注意：经 tsx 运行时 process.argv[1] 指向 tsx 加载器而非本文件，import.meta.url 自启动判定会失效，
// 故此处直接调用 main()（本模块仅被 start 脚本引用，无测试导入，不会误触发）。
void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
