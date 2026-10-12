/**
 * 入口（Node sidecar）：配置加载 → checkpoint 恢复 → 本地控制 API(8761) → 审计轮次。
 *
 * 配置优先级：环境变量 TAOBAO_AUDIT_* > ~/.config/taobao-audit/config.json >
 * 首次运行随机 token（0600 落盘）。上游审计源为 §1 现有 API（默认 http://127.0.0.1:8760）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createAuditLoop,
  type AuditLoop,
  type LoopStatus,
  type RoundOutcome,
  type RunRound,
} from './audit-loop';
import {
  cleanupTempFiles,
  defaultCheckpointPath,
  defaultConfigDir,
  fsIo,
  loadCheckpoint,
  saveCheckpoint,
  type CheckpointIo,
} from './checkpoint';
import {
  createApiServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type TaobaoServer,
} from './server';

export const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:8760';
export const DEFAULT_TARGET_ROUNDS = 5;
export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000; // §0 契约：所有 fetch 30s 超时

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface StoredConfig {
  host?: string;
  port?: number;
  token?: string;
  target?: number;
  intervalMs?: number;
  upstreamUrl?: string;
  fetchTimeoutMs?: number;
  project?: string;
  sessionUrl?: string;
}

export interface TaobaoConfig {
  host: string;
  port: number;
  token: string;
  target: number;
  intervalMs: number;
  fetchTimeoutMs: number;
  upstreamUrl: string;
  upstreamToken: string;
  configDir: string;
  configPath: string;
  checkpointPath: string;
  auditLogPath: string;
  project: string;
  sessionUrl: string;
}

function pickStr(env: string | undefined, file: string | undefined): string | undefined {
  const v = env ?? file;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = toNumber(v) ?? fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 上游 token：env DEEPSEEK_STUDIO_TOKEN > ~/.config/deepseek-studio/config.json（只读，不写凭据）。 */
function readUpstreamToken(home: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(home, '.config', 'deepseek-studio', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

export interface LoadConfigDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (file: string) => string;
  writeFile?: (file: string, data: string, mode: number) => void;
  mkdir?: (dir: string) => void;
  randomToken?: () => string;
  log?: (msg: string) => void;
}

export function loadConfig(deps: LoadConfigDeps = {}): TaobaoConfig {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const log = deps.log ?? ((m) => console.warn(m));
  const readFile = deps.readFile ?? ((f) => fs.readFileSync(f, 'utf8'));
  const writeFile = deps.writeFile ?? ((f, d, mode) => void fs.writeFileSync(f, d, { mode }));
  const mkdir = deps.mkdir ?? ((d) => void fs.mkdirSync(d, { recursive: true }));
  const randomToken = deps.randomToken ?? (() => randomBytes(24).toString('base64url'));

  const configDir = defaultConfigDir(env, home);
  const configPath = path.join(configDir, 'config.json');
  let stored: StoredConfig = {};
  let hasStoredToken = false;
  let configCorrupt = false;
  try {
    stored = JSON.parse(readFile(configPath)) as StoredConfig;
    hasStoredToken = typeof stored.token === 'string' && stored.token.length > 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      // 区分「首次运行」与「文件损坏」：损坏不覆盖磁盘，只用内存 token（§1 同语义）。
      configCorrupt = true;
      log(`[taobao] 配置文件损坏（${configPath}）：${errText(err)}。以内存随机 token 启动，不覆盖磁盘文件。`);
    }
    stored = {};
  }

  const envToken = pickStr(env.YUANBAO_AUDIT_TOKEN, undefined);
  const token = envToken ?? (hasStoredToken ? (stored.token as string) : randomToken());

  const host = pickStr(env.YUANBAO_AUDIT_HOST, stored.host) ?? DEFAULT_HOST;
  const port = clampInt(toNumber(env.YUANBAO_AUDIT_PORT) ?? stored.port, DEFAULT_PORT, 1, 65535);
  const target = clampInt(toNumber(env.YUANBAO_AUDIT_TARGET) ?? stored.target, DEFAULT_TARGET_ROUNDS, 1, 1_000_000);
  const intervalMs = clampInt(
    toNumber(env.YUANBAO_AUDIT_INTERVAL_MS) ?? stored.intervalMs,
    DEFAULT_INTERVAL_MS,
    0,
    24 * 3600 * 1000,
  );
  const fetchTimeoutMs = clampInt(
    toNumber(env.YUANBAO_AUDIT_FETCH_TIMEOUT_MS) ?? stored.fetchTimeoutMs,
    DEFAULT_FETCH_TIMEOUT_MS,
    1,
    600_000,
  );
  const upstreamUrl = (pickStr(env.YUANBAO_AUDIT_UPSTREAM_URL, stored.upstreamUrl) ?? DEFAULT_UPSTREAM_URL).replace(
    /\/+$/,
    '',
  );
  const upstreamToken = env.DEEPSEEK_STUDIO_TOKEN ?? readUpstreamToken(home) ?? '';
  const project = pickStr(env.YUANBAO_AUDIT_PROJECT, stored.project) ?? 'default';
  const sessionUrl = pickStr(env.YUANBAO_AUDIT_SESSION_URL, stored.sessionUrl) ?? 'https://chat.deepseek.com';

  if (!hasStoredToken && !envToken && !configCorrupt) {
    try {
      mkdir(configDir);
      const toWrite: Record<string, unknown> = { host, port, token, target, intervalMs, upstreamUrl };
      writeFile(configPath, `${JSON.stringify(toWrite, null, 2)}\n`, 0o600);
    } catch (err) {
      log(`[taobao] 无法持久化配置到 ${configPath}: ${errText(err)}（fail-open，token 仅本进程有效）`);
    }
  }

  return {
    host,
    port,
    token,
    target,
    intervalMs,
    fetchTimeoutMs,
    upstreamUrl,
    upstreamToken,
    configDir,
    configPath,
    checkpointPath: defaultCheckpointPath(configDir),
    auditLogPath: path.join(configDir, 'audit-log.jsonl'),
    project,
    sessionUrl,
  };
}

export interface UpstreamAuditEntry {
  id?: string;
  at?: number;
  tool?: string;
  outcome?: string;
  ok?: boolean;
  [k: string]: unknown;
}

/** 拉上游审计快照：GET /v1/tools/audit，Bearer + AbortSignal.timeout(30s)（§0 契约）。 */
export async function fetchUpstreamAudit(
  cfg: Pick<TaobaoConfig, 'upstreamUrl' | 'upstreamToken' | 'fetchTimeoutMs'>,
  opts: { fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<UpstreamAuditEntry[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const res = await fetchImpl(`${cfg.upstreamUrl}/v1/tools/audit?limit=${limit}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cfg.upstreamToken}` },
    signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
  });
  if (!res.ok) throw new Error(`upstream /v1/tools/audit → HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body?.data)) throw new Error('upstream /v1/tools/audit: unexpected payload');
  return body.data as UpstreamAuditEntry[];
}

export interface RunRoundDeps {
  fetchImpl?: typeof fetch;
  appendFile?: (file: string, data: string) => Promise<void>;
  now?: () => number;
}

/** 一轮的真实动作：拉上游审计 → 追加 audit-log.jsonl（一行一轮，含全部条目）。 */
export function buildRunRound(cfg: TaobaoConfig, deps: RunRoundDeps = {}): RunRound {
  const appendFile = deps.appendFile ?? (async (f: string, d: string) => void (await fsp.appendFile(f, d, 'utf8')));
  const now = deps.now ?? Date.now;
  return async (ctx): Promise<RoundOutcome> => {
    try {
      const entries = await fetchUpstreamAudit(cfg, { fetchImpl: deps.fetchImpl });
      const line = {
        at: now(),
        round: ctx.round,
        target: ctx.target,
        count: entries.length,
        entries,
      };
      await appendFile(cfg.auditLogPath, `${JSON.stringify(line)}\n`);
      return { ok: true, summary: `round ${ctx.round}/${ctx.target}: ${entries.length} entries` };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  };
}

export interface RuntimeDeps {
  io?: CheckpointIo;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  log?: (msg: string) => void;
}

export interface Runtime {
  loop: AuditLoop;
  server: TaobaoServer;
  restored: LoopStatus | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createRuntime(config: TaobaoConfig, deps: RuntimeDeps = {}): Promise<Runtime> {
  const io = deps.io ?? fsIo;
  const log = deps.log ?? ((m: string) => console.log(m));
  await io.ensureDir(config.configDir);
  await cleanupTempFiles(config.configDir, io);

  const loaded = await loadCheckpoint(config.checkpointPath, io);
  let restored: LoopStatus | null = null;
  // seenRounds = 元宝页面已完成的轮次编号（由注入层 /v1/report 上报）；这里从 checkpoint 恢复。
  let seenRounds: number[] = loaded.ok ? [...loaded.checkpoint.seenRounds] : [];
  if (loaded.ok) {
    const c = loaded.checkpoint;
    restored = { state: c.state, rounds: c.rounds, target: c.target, lastRound: c.lastRound };
    log(`[yuanbao] 恢复 checkpoint：state=${c.state} rounds=${c.rounds}/${c.target} project=${c.project}`);
  } else if (loaded.reason !== 'missing') {
    log(`[yuanbao] checkpoint 不可用（${loaded.reason}${loaded.error ? `: ${loaded.error}` : ''}），按新任务启动`);
  }

  const loop = createAuditLoop({
    target: config.target,
    intervalMs: config.intervalMs,
    runRound: buildRunRound(config, { fetchImpl: deps.fetchImpl, now: deps.now }),
    restored: restored ?? undefined,
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    log,
    onSettled: async (s) => {
      await saveCheckpoint(config.checkpointPath, {
        ...s,
        project: config.project,
        sessionUrl: config.sessionUrl,
        seenRounds: [...seenRounds],
      }, io, deps.now ?? Date.now);
    },
  });

  const server = createApiServer({
    config: { host: config.host, port: config.port, token: config.token },
    loop,
    allowLoopbackUnauthenticated: process.env.TAOBAO_AUDIT_AUTH === 'loopback',
    statusExtras: () => ({
      project: config.project,
      sessionUrl: config.sessionUrl,
      seenRounds: [...seenRounds],
    }),
    auditLogPath: config.auditLogPath,
  });

  return {
    loop,
    server,
    restored,
    async start() {
      await server.start();
      log(`[taobao] 控制 API on ${server.url}`);
      if (loop.status().state === 'running') {
        loop.run();
        log('[taobao] 断点续跑：轮次调度已恢复');
      }
    },
    async stop() {
      loop.dispose();
      await server.stop();
    },
  };
}

// ── 孤儿防护：父进程（Tauri 壳）消失 → self-exit（§1 同实现）──────────────
export type GuardDeps = {
  getPpid: () => number;
  alive: (pid: number) => boolean;
  exit: (code: number) => void;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  on: (sig: 'SIGTERM' | 'SIGBREAK', fn: () => void) => void;
  log?: (msg: string) => void;
};

export function installOrphanGuard(d: GuardDeps, intervalMs = 2_000): () => void {
  const ppid0 = d.getPpid();
  const timer = d.setInterval(() => {
    if (d.getPpid() !== ppid0 || !d.alive(ppid0)) {
      d.log?.(`[taobao] 父进程 ${ppid0} 消失，孤儿防护触发 self-exit`);
      d.exit(0);
    }
  }, intervalMs);
  const stop = () => d.clearInterval(timer);
  for (const sig of ['SIGTERM', 'SIGBREAK'] as const) {
    d.on(sig, () => {
      stop();
      d.exit(0);
    });
  }
  return stop;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  await runtime.start();
  console.log(`[taobao] token 取自 TAOBAO_AUDIT_TOKEN 或 ${config.configPath}`);
  console.log(`[taobao] 审计任务：${runtime.loop.status().rounds}/${config.target} 轮，间隔 ${config.intervalMs}ms`);
  console.log(`[taobao] 上游审计源 ${config.upstreamUrl}/v1/tools/audit（超时 ${config.fetchTimeoutMs}ms）`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[taobao] 收到 ${sig}，退出中`);
    await runtime.stop();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGBREAK', () => void shutdown('SIGBREAK'));
}

if (!process.env.STUDIO_TEST) {
  installOrphanGuard({
    getPpid: () => process.ppid,
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    exit: (c) => process.exit(c),
    setInterval,
    clearInterval,
    on: (sig, fn) => void process.on(sig, fn),
    log: (m) => console.warn(m),
  });
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
