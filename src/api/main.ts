/**
 * 入口：由 Node 原型宿主（后续 v0.7 由 Tauri 主进程）拉起本地 HTTP API + 常驻授权方。
 *
 * 配置来源（优先级从高到低）：环境变量 DEEPSEEK_STUDIO_* > 本地配置文件 >
 * 自动生成（首次运行随机 token/secret 并落盘 ~/.config/deepseek-studio/config.json，权限 0600）。
 * 端口固定 8760（避开豆包沙箱 8756 和 DeskPilot 8765）。
 */

import { createDesktopHost } from '../host/desktop-host';
import { createApiEngine } from '../host/engine/api-engine';
import { createWorkspace } from '../host/workspace';
import { POLICY_MODE_LABELS } from '../host/policy';
import fs from 'node:fs';
import path from 'node:path';
import { FilePersonaRegistry } from '../host/bot/persona-registry';
import { generatePairingCode } from './agent-lan-access';
// C1 P0-2：配置加载抽到独立模块（纯函数、无副作用、路径可注入 → 可安全单测）。
import { loadConfig } from './config-loader';
import { runStartupMigration } from '../host/config-migration';
import { resolveConfigDir, resolveStudioDistribution } from '../shared/distribution';
import { isQueryOnly as isQueryOnlyRun } from './cli-args';
// TD-04：资源根解析（安装版靠 STUDIO_RESOURCE_ROOT，开发树回退 import.meta.url）。
import { missingResourceFiles, resolveResourceRoot, resourceRootDiagnostics } from './resource-root';

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


export async function main(): Promise<void> {
  // 批 N+1 可观测性：把**自己实际读到的**形态与两个目录打到 stdout —— 装版的 stdout
  // 由 Rust 重定向进 `sidecar-<ms>.log`，于是「装版到底被注入了什么」在真机上可核
  // （批 N 之前 Rust 那几行是 `eprintln!`，装版无控制台 → 永久丢失，只能靠推断）。
  // 与 Rust 侧 `HostEntry::describe()` 写进的是**同一份文件**，两边可对账。
  console.log(
    `[studio] host env: STUDIO_DISTRIBUTION=${process.env.STUDIO_DISTRIBUTION ?? '(unset)'} ` +
      `STUDIO_CONFIG_DIR=${process.env.STUDIO_CONFIG_DIR ?? '(unset)'} ` +
      `STUDIO_LOG_DIR=${process.env.STUDIO_LOG_DIR ?? '(unset)'} ` +
      `resolved_config_dir=${resolveConfigDir()} mode=${resolveStudioDistribution()}`,
  );
  // 批 N+1 段 3：装版首启迁移**必须是第一件事** —— 早于 loadConfig/任何落点解析，
  // 否则新的 STUDIO_CONFIG_DIR 还是空的，宿主会先在新目录里写一份空配置，
  // 迁移再进来就只能跳过已存在的文件 → 老配置「看起来消失」。
  // dev（含 vitest / tsx）形态直接返回，行为不变。
  runStartupMigration();
  const { config, secret, workspaceRoot, policyMode, chatRooms, chatRoomMaxDepth, apiEngine: configuredApiEngine, configPath } = loadConfig();
  // F1/F2：apiEngine 在探测中可能被置空，用 let。
  let apiEngine = configuredApiEngine;
  // P2：局域网访问模式。默认关闭（只放行 loopback，与历史行为一致）。
  // 开启后非 loopback 请求必须带配对码，否则 /agent 返回 403 且不下发内嵌令牌的页面。
  const lanEnabled = /^(1|true|yes|on)$/i.test(process.env.DEEPSEEK_STUDIO_LAN ?? '');
  const pairingCode = (process.env.DEEPSEEK_STUDIO_PAIR_CODE ?? '').trim();
  // 未显式配置配对码却开了局域网：生成一个随机的并真正启用它。
  // 不能只在日志里显示——服务端若仍收到空串，decideAgentAccess 会 fail-closed
  // 拒绝所有非回环请求，日志就成了骗人的摆设。
  const effectivePairingCode = pairingCode || (lanEnabled ? generatePairingCode() : '');
  const workspace = workspaceRoot ? createWorkspace(workspaceRoot) : null;
  // M1 智能体面板静态资源（esbuild 产物：src/ui/agent.html + dist/agent-panel.js）
  //
  // TD-04（发版阻断）：资源根**不再**靠 import.meta.url 反推仓库根。
  // 旧写法在开发树恰好成立（入口在 src/api/），安装版不成立 —— 打包后入口是
  // <res>/host/main.mjs，上溯两级得到安装目录的父目录，资源全部找不到。
  // 现在由 resolveResourceRoot 解析：① STUDIO_RESOURCE_ROOT（Tauri sidecar 传入
  // resource_dir()）优先；② 缺省回退 import.meta.url 上溯两级（开发树行为不变）。
  const resourceRoot = resolveResourceRoot(process.env, import.meta.url);
  const agentPage = {
    htmlPath: path.join(resourceRoot, 'src', 'ui', 'agent.html'),
    jsPath: path.join(resourceRoot, 'dist', 'agent-panel.js'),
    cssPath: path.join(resourceRoot, 'src', 'ui', 'agent.css'),
    // P2：PWA 附属资源。
    manifestPath: path.join(resourceRoot, 'src', 'ui', 'agent.webmanifest'),
    swPath: path.join(resourceRoot, 'src', 'ui', 'agent-sw.js'),
    icon192Path: path.join(resourceRoot, 'src', 'ui', 'icon-192.png'),
    icon512Path: path.join(resourceRoot, 'src', 'ui', 'icon-512.png'),
  };
  // TD-04：资源根体检 —— 缺文件时给一行明确诊断，而不是让 /agent 变成 500/白屏。
  // C 卡（MCP 独立原生窗口）：页面壳资源（与 agentPage 同一套路径约定）。
  //
  // ⚠️ 壳**不含令牌**（token 由 Tauri init script 注入该窗：`mcp_settings_init_script`），
  // 所以它不走 Bearer 闸 —— 顶层导航带不了 `Authorization`，Tauri 2.12.2 也没有给导航
  // 加请求头的钩子（PM 2026-11-06 裁定）。这条链唯一的安全边界是「壳里没有秘密」，
  // 机器判据 = tests/desktop/mcp-settings-window.test.ts（扫产物 + 响应体，附装置自检）。
  //
  // 这三条路径是**壳的固化契约**：UI 侧按此产出（`src/ui/mcp-settings.html`、
  // `src/ui/mcp-settings.css`、`src/ui/mcp-settings-panel.ts` → `dist/mcp-settings-panel.js`）。
  const mcpSettingsPage = {
    htmlPath: path.join(resourceRoot, 'src', 'ui', 'mcp-settings.html'),
    jsPath: path.join(resourceRoot, 'dist', 'mcp-settings-panel.js'),
    cssPath: path.join(resourceRoot, 'src', 'ui', 'mcp-settings.css'),
  };
  {
    // fail-visible：壳缺失时给一行明确诊断（该窗会 500），而不是让人对着白屏猜。
    // 刻意**不进** RESOURCE_FILES：那会让「资源根无效」在壳未产出前误报为装版故障。
    const missingShell = [mcpSettingsPage.htmlPath, mcpSettingsPage.jsPath, mcpSettingsPage.cssPath].filter(
      (p) => !fs.existsSync(p),
    );
    if (missingShell.length > 0) {
      console.warn(
        `[deepseek-studio] MCP 设置窗页面壳尚未产出（该窗会显示 500，其余功能不受影响）：${missingShell.join('、')}`,
      );
    }
  }
  {
    const missingResources = missingResourceFiles(resourceRoot, (p) => fs.existsSync(p));
    const diagnostics = resourceRootDiagnostics(resourceRoot, missingResources);
    if (diagnostics) {
      console.error(diagnostics);
    } else {
      console.log(`[deepseek-studio] 资源根: ${resourceRoot}`);
    }
  }
  const personas = new FilePersonaRegistry();
  // F1：ApiEngine 启动前健康探测。key 失效或网络不通时清空 apiEngine，
  // 让 createDesktopHost 走 WebEngine（网页拦截），避免 AgentLoop 静默收空回复。
  // createDesktopHost 是同步工厂，探测必须在它构造 main bot 引擎前完成。
  if (apiEngine?.apiKey) {
    const probeEngine = createApiEngine({
      config: {
        baseURL: apiEngine.baseURL,
        apiKey: apiEngine.apiKey,
        model: apiEngine.model,
      },
    });
    const probeHealth = await probeEngine.health();
    if (!probeHealth.ok) {
      console.warn(
        `[deepseek-studio] F1: ApiEngine health probe failed (${probeHealth.reason ?? "unknown"}) — ` +
        "falling back to WebEngine. Fix or remove apiEngine.apiKey in ~/.config/deepseek-studio/config.json",
      );
      apiEngine = undefined;
    } else {
      console.log("[deepseek-studio] F1: ApiEngine health probe OK, using API engine");
    }
  }
  const host = createDesktopHost({
    config, secret, workspace, policyMode, agentPage, apiEngine,
    mcpSettingsPage,
    chatRooms: chatRooms.length > 0 ? chatRooms : undefined,
    chatRoomMaxDepth,
    personas,
    agentLanAccess: { lanEnabled, pairingCode: effectivePairingCode },
  });
  if (chatRooms.length > 0) {
    console.log(`[deepseek-studio] 聊天室模式启用：${chatRooms.map((r) => r.roomName).join(', ')}`);
  }
  // W9：EADDRINUSE 明确报错（端口号 + 当前 host/port + config.json 路径），
  // 不做静默换端口；退出码非 0。
  try {
    await host.start();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'EADDRINUSE') {
      console.error('[deepseek-studio] 端口冲突（EADDRINUSE）：无法绑定本地 API。');
      console.error(`  当前配置：host=${config.host} port=${config.port}`);
      console.error(`  配置文件：${configPath}（可修改其中 port，或先关闭占用 ${config.port} 的进程后重启）`);
      console.error('  本进程不自动换端口，以免聊天室按旧 wsUrl 连到不存在的地址。');
      process.exit(2);
    }
    throw err;
  }
  console.log(`[deepseek-studio] 本地 HTTP API on ${host.url}`);
  if (lanEnabled) {
    console.warn('[deepseek-studio] ⚠️  局域网访问已开启（DEEPSEEK_STUDIO_LAN=1）：服务监听非回环地址。');
    console.warn('[deepseek-studio] ⚠️  /agent 页面内嵌完整 API 令牌，同局域网设备拿到即可控制 agent。');
    console.warn(`[deepseek-studio] ⚠️  手机访问必须带配对码：http://<本机局域网IP>:${config.port}/agent?pair=${effectivePairingCode}`);
    if (!pairingCode) {
      console.warn('[deepseek-studio] ⚠️  未配置 DEEPSEEK_STUDIO_PAIR_CODE，本次使用随机配对码（重启后失效）。');
    }
  }
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
//
// 但必须放过 CLI 查询类参数：`tsx src/api/main.ts --help` / `--version` 本该只打印
// 帮助信息就退出，旧代码无条件跑 main() 会把整个宿主（含 8760 监听）拉起来，
// 留下一个谁都不管的孤儿 node 占着端口。20261023 实测该孤儿从 14:39 活到 15:2x，
// 并直接导致后续启动撞 EADDRINUSE → process.exit(2) → StartupFailed。
// argv[1] 是被执行的脚本路径（tsx 下是 main.ts），只有它之后才是用户参数。
// 判据：存在 --help/-h/--version/-V 且**没有**其它实参 → 只查询，不起宿主。
// 正常启动（tsx src/api/main.ts，无附加参数）必须落到下面的 main()。
//
// 解析逻辑抽到 `./cli-args`（纯函数、可单测）：本文件有顶层副作用（会起 8760 宿主），
// 不能为了测这段判据去 import 它。2026-11-06 引入 dev 入口 `dev-main.ts` 后，
// 「按文件名结尾猜脚本路径」这种写法不再成立 → 改成枚举入口名（见 cli-args.ts 注释）。
const isQueryOnly = isQueryOnlyRun(process.argv);
if (isQueryOnly) {
  // 只打印用法，不起宿主。stdout 供人读，退出码 0。
  // 本文件在 src/api/ 下，package.json 在仓库根 → 要上跳两级。
  const pkgUrl = new URL('../../package.json', import.meta.url);
  let version = 'unknown';
  try {
    version = (JSON.parse(fs.readFileSync(pkgUrl, 'utf-8')) as { version?: string }).version ?? 'unknown';
  } catch {
    // 读不到 package.json 不影响帮助输出
  }
  console.log('deepseek-studio host');
  console.log(`  version: ${version}`);
  console.log('  usage:   tsx src/api/main.ts');
  console.log('  env:     DEEPSEEK_STUDIO_TOKEN / STUDIO_WORKSPACE_ROOT / STUDIO_SKILLS_DIR');
  process.exit(0);
}
void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
