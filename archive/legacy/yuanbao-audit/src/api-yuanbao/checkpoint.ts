/**
 * checkpoint.json 状态持久化
 *
 * 写协议：同目录 tmp → fsync → rename（原子替换）→ 目录 fsync（尽力而为）。
 * 读协议：missing / unreadable / corrupt 分开上报；corrupt 文件保留原样，不自动覆盖。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { LOOP_STATES, type LoopState, type LoopStatus } from './audit-loop';

export const CHECKPOINT_VERSION = 1 as const;

export interface Checkpoint extends LoopStatus {
  version: typeof CHECKPOINT_VERSION;
  updatedAt: number;
  project: string;
  seenRounds: number[];
  sessionUrl: string;
}

/** 文件系统访问面：测试可注入录制实现，生产用 fsIo。 */
export interface CheckpointIo {
  ensureDir(dir: string): Promise<void>;
  writeFileSynced(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  read(file: string): Promise<string>;
  list(dir: string): Promise<string[]>;
  remove(file: string): Promise<void>;
  fsyncDir(dir: string): Promise<void>;
}

export const fsIo: CheckpointIo = {
  async ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  },
  async writeFileSynced(file, data) {
    const fh = await fsp.open(file, 'w', 0o600);
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  async rename(from, to) {
    await fsp.rename(from, to);
  },
  async read(file) {
    return await fsp.readFile(file, 'utf8');
  },
  async list(dir) {
    return await fsp.readdir(dir);
  },
  async remove(file) {
    await fsp.unlink(file);
  },
  async fsyncDir(dir) {
    // POSIX：目录 fsync 让 rename 尽快入盘；Windows 打开目录会失败，忽略。
    try {
      const dh = await fsp.open(dir, 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      /* best effort */
    }
  },
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.YUANBAO_AUDIT_CONFIG_DIR;
  return override && override.trim() ? override.trim() : path.join(home, '.config', 'yuanbao-audit');
}

export function defaultCheckpointPath(configDir: string): string {
  return path.join(configDir, 'checkpoint.json');
}

/** tmp 文件名必须与目标同目录（跨卷 rename 不是原子的）。 */
export function tmpNameFor(file: string): string {
  const rand = randomBytes(6).toString('hex');
  return path.join(path.dirname(file), `${path.basename(file)}.tmp-${process.pid}-${rand}`);
}

export async function atomicWriteFile(file: string, data: string, io: CheckpointIo = fsIo): Promise<void> {
  const dir = path.dirname(file);
  await io.ensureDir(dir);
  const tmp = tmpNameFor(file);
  try {
    await io.writeFileSynced(tmp, data);
    await io.rename(tmp, file);
  } catch (err) {
    await io.remove(tmp).catch(() => undefined);
    throw err;
  }
  await io.fsyncDir(dir);
}

function toCount(v: unknown, min: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < min) return null;
  return Math.floor(v);
}

/** 纯函数：把外部 JSON 规整为合法 checkpoint；任何关键字段非法 → null（fail-closed，不猜）。 */
export function normalizeCheckpoint(input: unknown): Checkpoint | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (o.version !== CHECKPOINT_VERSION) return null;
  if (typeof o.state !== 'string' || !(LOOP_STATES as readonly string[]).includes(o.state)) return null;

  const rounds = toCount(o.rounds, 0);
  const target = toCount(o.target, 1);
  const updatedAt = toCount(o.updatedAt, 0);
  if (rounds === null || target === null || updatedAt === null) return null;

  let lastRound: number | null = null;
  if (o.lastRound !== null && o.lastRound !== undefined) {
    lastRound = toCount(o.lastRound, 0);
    if (lastRound === null) return null;
  }

  if (typeof o.project !== 'string' || !o.project.trim()) return null;
  if (typeof o.sessionUrl !== 'string' || !o.sessionUrl.trim()) return null;

  let seenRounds: number[] = [];
  if (Array.isArray(o.seenRounds)) {
    seenRounds = o.seenRounds
      .map((n: unknown) => toCount(n, 0))
      .filter((n: number | null): n is number => n !== null);
  }

  return {
    version: CHECKPOINT_VERSION,
    state: o.state as LoopState,
    rounds,
    target,
    lastRound,
    updatedAt,
    project: o.project,
    seenRounds,
    sessionUrl: o.sessionUrl,
  };
}

export async function saveCheckpoint(
  file: string,
  status: LoopStatus & { project: string; sessionUrl: string; seenRounds?: number[] },
  io: CheckpointIo = fsIo,
  now: () => number = Date.now,
): Promise<Checkpoint> {
  const cp: Checkpoint = {
    version: CHECKPOINT_VERSION,
    ...status,
    seenRounds: status.seenRounds ?? [],
    updatedAt: now(),
  };
  const normalized = normalizeCheckpoint(cp);
  if (!normalized) throw new Error(`invalid checkpoint state: ${JSON.stringify(status)}`);
  await atomicWriteFile(file, `${JSON.stringify(normalized, null, 2)}\n`, io);
  return normalized;
}

export type CheckpointLoad =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; reason: 'missing' | 'unreadable' | 'corrupt'; error?: string };

export async function loadCheckpoint(file: string, io: CheckpointIo = fsIo): Promise<CheckpointLoad> {
  let raw: string;
  try {
    raw = await io.read(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable', error: errText(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'corrupt', error: `invalid json: ${errText(err)}` };
  }
  const cp = normalizeCheckpoint(parsed);
  if (!cp) return { ok: false, reason: 'corrupt', error: 'schema mismatch' };
  return { ok: true, checkpoint: cp };
}

/** 启动时清理历史崩溃残留的 tmp 文件，返回清理个数。 */
export async function cleanupTempFiles(dir: string, io: CheckpointIo = fsIo): Promise<number> {
  let names: string[];
  try {
    names = await io.list(dir);
  } catch {
    return 0;
  }
  const victims = names.filter((n) => n.includes('.tmp-'));
  for (const n of victims) {
    await io.remove(path.join(dir, n)).catch(() => undefined);
  }
  return victims.length;
}
