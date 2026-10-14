/**
 * 入口：由 Node 原型宿主（后续 v0.7 由 Tauri 主进程）拉起本地 HTTP API + 常驻授权方。
 *
 * 配置来源（优先级从高到低）：环境变量 DEEPSEEK_STUDIO_* > 本地配置文件 >
 * 自动生成（首次运行随机 token/secret 并落盘 ~/.config/deepseek-studio/config.json，权限 0600）。
 * 端口固定 8760（避开豆包沙箱 8756 和 DeskPilot 8765）。
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
import type { RoomConfig } from '../host/bot/types';
import { FilePersonaRegistry } from '../host/bot/persona-registry';

// ── v0.12 Phase 1：孤儿防护（DCD 修正条件 3）──────────────────────────────
// 父进程（Tauri 主进程）消失 → self-exit，不留孤儿 Node。
// POSIX：父死后 process.ppid 变为 1（变化可判）；
// Windows：ppid 是启动时记录的陈旧值（父死后不变），必须再做 liveness 探活
//         （process.kill(pid, 0)：ESRCH=已消失，EPERM=存在但无权限）。
type GuardDeps = {
  getPpid: () => number;
  alive: (pid: number) => boolean;
  exit: (code: number) => void;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  on: (sig: 'SIGTERM' | 'SIGBREAK', fn: () => void) => void;
  log?: (msg: string) => void;
};
function installOrphanGuard(d: GuardDeps, intervalMs = 2_000): () => void {
  const ppid0 = d.getPpid();
  const timer = d.setInterval(() => {
    if (d.getPpid() !== ppid0 || !d.alive(ppid0)) {
      d.log?.(`[deepseek-studio] 父进程 ${ppid0} 消失，孤儿防护触发 self-exit`);
      d.exit(0);
    }
  }, intervalMs);
  const stop = () => d.clearInterval(timer);
  for (const sig of ['SIGTERM', 'SIGBREAK'] as const) {
    d.on(sig, () => { stop(); d.exit(0); });
  }
  return stop;
}
if (!process.env.STUDIO_TEST) {
  installOrphanGuard({
    getPpid: () => process.ppid,
    alive: (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
    },
    exit: (c) => process.exit(c),
    setInterval, clearInterval,
    on: (sig, fn) => { process.on(sig, fn); },
    log: (m) => console.warn(m),
  }, 500);
}
// ── 孤儿防护结束 ────────────────────────────────────────────────────────

interface StoredConfig extends Partial<ApiConfig> {
  secret?: string;
  /** v0.5：工作区根（也可用环境变量 STUDIO_WORKSPACE_ROOT 覆盖）。 */
  workspaceRoot?: string;
  /** v0.5：命令审批档位 ask / auto / full（默认 ask）。 */
  policyMode?: string;
  /** v0.27：聊天室配置。提供后启用聊天室模式（@路由 + 多 bot 编排）。 */
  chatRooms?: Array<{ roomId: string; roomName: string; hostPersona?: string; memberPersonas: string[] }>;
  /** v0.27：聊天室编排波数（默认 1）。 */
  chatRoomMaxDepth?: number;
}
interface ResolvedConfig {
  config: ApiConfig;
  secret: string;
  workspaceRoot: string;
  policyMode: PolicyMode;
  chatRooms: ReadonlyArray<RoomConfig>;
  chatRoomMaxDepth?: number;
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
  } catch (err: unknown) {
    // 区分"文件不存在"（首次运行，生成新配置）和"文件损坏"（应告警，不覆盖）
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.error(
        `[deepseek-studio] 配置文件损坏（${cfgPath}）：${err instanceof Error ? err.message : String(err)}。` +
        ' 将以内存随机 token 启动，不覆盖磁盘上的损坏文件。',
      );
      // 不生成新 token 覆盖，使用内存随机值
      stored = {};
    }
  }

  const token = process.env.DEEPSEEK_STUDIO_TOKEN ?? stored.token ?? randomToken();
  const secret = process.env.DEEPSEEK_STUDIO_SECRET ?? stored.secret ?? randomToken();
  const host = process.env.DEEPSEEK_STUDIO_HOST ?? stored.host ?? '127.0.0.1';
  const port = Number(process.env.DEEPSEEK_STUDIO_PORT ?? stored.port ?? 8760);

  // v0.5：工作区根与审批档位。档位非法值一律回落到 auto（fail-safe：宁可多问不可少问）。
  const workspaceRoot = process.env.STUDIO_WORKSPACE_ROOT ?? stored.workspaceRoot ?? '';
  const rawMode = process.env.STUDIO_POLICY_MODE ?? stored.policyMode ?? '';
  const policyMode: PolicyMode = isPolicyMode(rawMode) ? rawMode : DEFAULT_POLICY_MODE;

  // v0.27：聊天室配置。从 config.json 读 chatRooms，校验每条必须有 roomId/roomName/memberPersonas。
  // 环境变量 STUDIO_CHAT_ROOMS_JSON 可覆盖（dry run / 测试用）。
  const chatRoomsJson = process.env.STUDIO_CHAT_ROOMS_JSON ?? JSON.stringify(stored.chatRooms ?? []);
  let chatRooms: RoomConfig[] = [];
  try {
    const parsed = JSON.parse(chatRoomsJson) as unknown;
    if (Array.isArray(parsed)) {
      chatRooms = parsed.filter(
        (r): r is RoomConfig =>
          r != null && typeof r === 'object'
          && typeof (r as { roomId?: unknown }).roomId === 'string'
          && typeof (r as { roomName?: unknown }).roomName === 'string'
          && Array.isArray((r as { memberPersonas?: unknown }).memberPersonas)
          && (r as { memberPersonas: unknown[] }).memberPersonas.every((p) => typeof p === 'string'),
      );
    }
  } catch (err) {
    console.warn(`[deepseek-studio] chatRooms 配置解析失败，聊天室模式不启用: ${err instanceof Error ? err.message : String(err)}`);
  }
  const chatRoomMaxDepth = typeof stored.chatRoomMaxDepth === 'number' ? stored.chatRoomMaxDepth : undefined;

  // 缺失则生成并落盘（仅本地文件，0600；不回显 secret）。
  // v0.13 修复：写入时保留 workspaceRoot/policyMode，避免覆盖用户配置。
  if (!stored.token || !stored.secret) {
    try {
      fs.mkdirSync(cfgDir, { recursive: true });
      const toWrite: Record<string, unknown> = { host, port, token, secret };
      if (workspaceRoot) toWrite.workspaceRoot = workspaceRoot;
      if (policyMode) toWrite.policyMode = policyMode;
      fs.writeFileSync(cfgPath, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
    } catch (err) {
      // fail-open：持久化失败仍可运行（token/secret 仅本进程有效）。
      console.warn(
        `[deepseek-studio] 无法持久化配置到 ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { config: { host, port, token }, secret, workspaceRoot, policyMode, chatRooms, chatRoomMaxDepth };
}

export async function main(): Promise<void> {
  const { config, secret, workspaceRoot, policyMode, chatRooms, chatRoomMaxDepth } = loadConfig();
  const workspace = workspaceRoot ? createWorkspace(workspaceRoot) : null;
  // M1 智能体面板静态资源（esbuild 产物：src/ui/agent.html + dist/agent-panel.js）
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const agentPage = {
    htmlPath: path.join(repoRoot, 'src', 'ui', 'agent.html'),
    jsPath: path.join(repoRoot, 'dist', 'agent-panel.js'),
    cssPath: path.join(repoRoot, 'src', 'ui', 'agent.css'),
  };
  const personas = new FilePersonaRegistry();
  const host = createDesktopHost({
    config, secret, workspace, policyMode, agentPage,
    chatRooms: chatRooms.length > 0 ? chatRooms : undefined,
    chatRoomMaxDepth,
    personas,
  });
  if (chatRooms.length > 0) {
    console.log(`[deepseek-studio] 聊天室模式启用：${chatRooms.map((r) => r.roomName).join(', ')}`);
  }
  await host.start();
  console.log(`[deepseek-studio] 本地 HTTP API on ${host.url}`);
  console.log('[deepseek-studio] token 取自 DEEPSEEK_STUDIO_TOKEN 或 ~/.config/deepseek-studio/config.json');
  console.log(
    workspace
      ? `[deepseek-studio] 工作区: ${workspace.root}（区内自动放行，区外按策略）`
      : '[deepseek-studio] 工作区未配置 → file.* 能力不可用（请设 STUDIO_WORKSPACE_ROOT 或用户配置 workspaceRoot）',
  );
  console.log(`[deepseek-studio] 命令审批档位: ${POLICY_MODE_LABELS[policyMode]} (${policyMode})`);

  // v0.15：同进程启动 Lever-Hub server（端口 8762）
  try {
    const { createLeverHubServer } = await import('../lever-hub/lever-hub-server');
    const leverHub = createLeverHubServer();
    await leverHub.start();
    console.log('[deepseek-studio] Lever-Hub API on http://127.0.0.1:8762');
  } catch (err) {
    console.warn(`[deepseek-studio] Lever-Hub 未启动（端口可能被占用）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 进程直接运行时自启动。
// 注意：经 tsx 运行时 process.argv[1] 指向 tsx 加载器而非本文件，import.meta.url 自启动判定会失效，
// 故此处直接调用 main()（本模块仅被 start 脚本引用，无测试导入，不会误触发）。
void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
