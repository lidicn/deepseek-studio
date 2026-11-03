/**
 * 用户配置加载（~/.config/deepseek-studio/config.json）。
 *
 * C1 P0-2 抽出来的原因：原逻辑在 `src/api/main.ts` 里，而该模块**导入即执行 main()**
 * （会起 8760 服务），无法被单测安全导入。本模块是**纯函数 + 无副作用**，
 * 配置路径可注入 → 测试用临时目录验证「坏配置不覆盖」「写盘合并保留既有字段」。
 *
 * 两条修复（对应 BUG-005 / BUG-004）：
 *   1. **坏配置绝不覆盖**：配置文件损坏时改名备份 `.bad`（原始字节保留供人工恢复），
 *      原文件保持不动，且**本次进程不写盘**。
 *      （原实现的注释承诺「不覆盖」，但代码把 stored 置空后仍会走到写盘分支 → 注释与实现矛盾。）
 *   2. **写盘改「读-改-写合并」**：以磁盘原始配置为基底，只覆盖本次真正变更的键，
 *      `chatRooms` / `chatRoomMaxDepth` / `apiEngine` 等用户配置不再被静默丢弃。
 *      口径与 `src/host/workspace.ts` 的 `persistConfigPatch` 一致。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ApiConfig } from './types';
import type { RoomConfig } from '../host/bot/types';
import { DEFAULT_POLICY_MODE, isPolicyMode, type PolicyMode } from '../host/policy';

export interface StoredConfig extends Partial<ApiConfig> {
  secret?: string;
  /** v0.5：工作区根（也可用环境变量 STUDIO_WORKSPACE_ROOT 覆盖）。 */
  workspaceRoot?: string;
  /** v0.5：命令审批档位 ask / auto / full（默认 ask）。 */
  policyMode?: string;
  /** v0.27：聊天室配置。提供后启用聊天室模式（@路由 + 多 bot 编排）。 */
  chatRooms?: Array<{ roomId: string; roomName: string; hostPersona?: string; memberPersonas: string[] }>;
  /** v0.27：聊天室编排波数（默认 1）。 */
  chatRoomMaxDepth?: number;
  /** v0.30：ApiEngine 配置（真实 API key，切 provider）。 */
  apiEngine?: { baseURL: string; apiKey: string; model: string };
}

export interface ResolvedConfig {
  config: ApiConfig;
  secret: string;
  workspaceRoot: string;
  policyMode: PolicyMode;
  chatRooms: ReadonlyArray<RoomConfig>;
  chatRoomMaxDepth?: number;
  apiEngine?: { baseURL: string; apiKey: string; model: string };
  /** W9：config.json 绝对路径，供 EADDRINUSE 错误提示回指。 */
  configPath: string;
  /**
   * C1 P0-2 / BUG-005：本次进程是否**禁止写盘**（配置文件损坏时为 true）。
   * 供调用方/测试断言「原文件与 .bad 备份均保持不动」。
   */
  configFileBroken: boolean;
}

/** 随机 token/secret（首次运行时生成）。编码必须与原 main.ts 保持一致（base64url）。 */
function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * 端口解析（TD-07）：非有限数 / 非整数 / `<1` / `>65535` → 回落 `fallback`（默认 8760）。
 *
 * 与同函数里 `isPolicyMode` 的 fail-safe 风格一致：宁可回落到已知可用端口，
 * 也不要让 `'abc'`（NaN）、`'0'`、`'99999'` 这类值直通到 `listen()` 才炸。
 *
 * ⚠️ 边界：`sidecar.rs` 的 `HEALTH_PORT` 是 DCD 契约常量（8760），本函数只负责
 * 「从 env/config 解析出要用的端口」，不改契约常量本身。
 */
export function parsePort(raw: unknown, fallback = 8760): number {
  // 字符串先去空白；其余类型（数字等）转 Number 后再统一校验。
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '' || text === null || text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < 1 || n > 65535) return fallback;
  return n;
}

/** 默认配置目录：~/.config/deepseek-studio */
export function defaultConfigDir(): string {
  return path.join(os.homedir(), '.config', 'deepseek-studio');
}

/**
 * 读取并解析用户配置。
 *
 * @param override.cfgDir  配置目录（默认 ~/.config/deepseek-studio）
 * @param override.cfgPath 配置文件路径（默认 <cfgDir>/config.json）
 */
export function loadConfig(override?: { cfgDir?: string; cfgPath?: string }): ResolvedConfig {
  const cfgDir = override?.cfgDir ?? defaultConfigDir();
  const cfgPath = override?.cfgPath ?? path.join(cfgDir, 'config.json');
  let stored: StoredConfig = {};
  // C1 P0-2 / BUG-005：配置损坏时**绝不能覆盖原文件**。
  // 原实现的注释承诺「不覆盖磁盘上的损坏文件」，但代码把 stored 置空后
  // 仍会走到「缺 token/secret → 写盘」分支 → 注释与实现自相矛盾，
  // 用户的损坏配置（哪怕只是手滑多打了个逗号）被**静默覆盖**、无法找回。
  // 现在：改名备份为 `.bad`（原始字节保留供人工恢复），**本次进程不写盘**。
  let configFileBroken = false;
  try {
    stored = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as StoredConfig;
  } catch (err: unknown) {
    // 区分"文件不存在"（首次运行，生成新配置）和"文件损坏"（应告警，不覆盖）
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      const backup = `${cfgPath}.bad`;
      console.error(
        `[deepseek-studio] 配置文件损坏（${cfgPath}）：${err instanceof Error ? err.message : String(err)}。` +
          ` 已备份为 ${backup}（原文件原地保留、字节不变），将以内存随机 token 启动，且本次不会写盘。`,
      );
      try {
        // **复制**而非改名：PM 的口径是「原文件不动」——改名会把原路径清空，
        // 用户/其它工具再读 config.json 就会得到 ENOENT，而不是「内容损坏」。
        fs.copyFileSync(cfgPath, backup);
      } catch (copyErr: unknown) {
        console.error(
          `[deepseek-studio] 损坏配置备份失败（${copyErr instanceof Error ? copyErr.message : String(copyErr)}），` +
            ' 原文件保持不动，本次不会写盘。',
        );
      }
      configFileBroken = true;
      // 不生成新 token 覆盖，使用内存随机值
      stored = {};
    }
  }

  const token = process.env.DEEPSEEK_STUDIO_TOKEN ?? stored.token ?? randomToken();
  const secret = process.env.DEEPSEEK_STUDIO_SECRET ?? stored.secret ?? randomToken();
  const host = process.env.DEEPSEEK_STUDIO_HOST ?? stored.host ?? '127.0.0.1';
  const port = parsePort(process.env.DEEPSEEK_STUDIO_PORT ?? stored.port ?? 8760);

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
          r != null &&
          typeof r === 'object' &&
          typeof (r as { roomId?: unknown }).roomId === 'string' &&
          typeof (r as { roomName?: unknown }).roomName === 'string' &&
          Array.isArray((r as { memberPersonas?: unknown }).memberPersonas) &&
          (r as { memberPersonas: unknown[] }).memberPersonas.every((p) => typeof p === 'string'),
      );
    }
  } catch (err) {
    console.warn(
      `[deepseek-studio] chatRooms 配置解析失败，聊天室模式不启用: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const chatRoomMaxDepth = typeof stored.chatRoomMaxDepth === 'number' ? stored.chatRoomMaxDepth : undefined;

  // 缺失则生成并落盘（仅本地文件，0600；不回显 secret）。
  // v0.13 修复：写入时保留 workspaceRoot/policyMode，避免覆盖用户配置。
  //
  // C1 P0-2 / BUG-004：原实现只写 6 个白名单字段（host/port/token/secret/workspaceRoot/policyMode），
  // **chatRooms / chatRoomMaxDepth / apiEngine 等用户配置被静默丢弃** ——
  // 用户配好的聊天室、真实 API key 在一次「补 token」的启动后就没了。
  // 现在改成「读-改-写合并」：以**磁盘上的原始配置**为基底，只覆盖本次真正变更的键，
  // 其余（已知与未知）一律保留。口径与 host/workspace.ts 的 persistConfigPatch 一致。
  //
  // C1 P0-2 / BUG-005：配置损坏时**本次不写盘**（避免覆盖用户原文件）。
  if (!configFileBroken && (!stored.token || !stored.secret)) {
    try {
      fs.mkdirSync(cfgDir, { recursive: true });
      // 读-改-写：基底 = 磁盘原始配置（解析失败则从空开始）。
      let base: Record<string, unknown> = {};
      try {
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          base = parsed as Record<string, unknown>;
        }
      } catch {
        // 文件不存在或不可解析：以空配置起步（此时就是首次运行）。
        base = {};
      }
      // 只覆盖本次真正需要变更的键；其余保持磁盘上的原值。
      const toWrite: Record<string, unknown> = {
        ...base,
        host,
        port,
        token,
        secret,
      };
      if (workspaceRoot) toWrite.workspaceRoot = workspaceRoot;
      if (policyMode) toWrite.policyMode = policyMode;
      fs.writeFileSync(cfgPath, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
    } catch (err) {
      // fail-open：持久化失败仍可运行（token/secret 仅本进程有效）。
      console.warn(
        `[deepseek-studio] 无法持久化配置到 ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (configFileBroken) {
    console.warn(
      `[deepseek-studio] 配置文件损坏，本次不写盘（原始文件与其 .bad 备份均保持不动）：${cfgPath}`,
    );
  }

  // F2：环境变量 DEEPSEEK_STUDIO_API_KEY 优先于 config.json 的 apiKey；
  // 用户可临时覆盖，也可清空变量走 WebEngine。
  let apiEngine = stored.apiEngine;
  const envKey = process.env.DEEPSEEK_STUDIO_API_KEY?.trim();
  if (envKey !== undefined) {
    if (envKey === '') {
      // 显式空串 = 强制禁用 ApiEngine（走 WebEngine）
      apiEngine = undefined;
    } else {
      apiEngine = {
        baseURL: apiEngine?.baseURL ?? 'https://api.deepseek.com',
        apiKey: envKey,
        model: apiEngine?.model ?? 'deepseek-chat',
      };
    }
  }
  return {
    config: { host, port, token },
    secret,
    workspaceRoot,
    policyMode,
    chatRooms,
    chatRoomMaxDepth,
    apiEngine,
    configPath: cfgPath,
    configFileBroken,
  };
}
