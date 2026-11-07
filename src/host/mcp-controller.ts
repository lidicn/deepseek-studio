/**
 * MCP 控制器（v1.0，移植自 deepseek++）
 *
 * 参考 deepseek++ 的 MCP 工具控制器，用 stdio 传输连接 MCP 服务器：
 * - 读取 MCP 服务器配置（命令、参数、环境变量）
 * - 通过 stdio 启动并连接 MCP 服务器
 * - 动态注册 MCP 工具到 studio 工具列表
 * - 转发工具调用到 MCP 服务器并返回结果
 *
 * 配置文件：~/.config/deepseek-studio/mcp-servers.json
 * 格式：{ "servers": { "server-id": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] } } }
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isInstalledDistribution } from '../shared/distribution';
import { writeFileAtomicSync } from '../shared/atomic-write';

/**
 * QD-R23 #1：**不在 `connections` map 里的**临时子进程（`testConnection` 的 `__test__` 连接）。
 *
 * 为什么必须单独登记（PM 实测，比原卡更硬）：`git grep '__test__' -- src` 只命中
 * `testConnection` 里那**一处赋值**，该 `conn` **从未 `connections.set()`** ⇒ 就算把
 * `disconnectAll()` 接到退出钩子上，**测过一次的连接仍在兜底之外**，只能靠 finally 那条腿，
 * 而那条腿原来是裸 `kill()`（`.cmd` 起的 MCP 只杀 `cmd.exe`，`npx` 真进程成孤儿）。
 */
const adHocChildren = new Set<ChildProcess>();

/** 收走所有登记在册的临时子进程（tree-kill）。供孤儿防护 / 退出钩子调用。 */
export function killAllAdHocChildren(): void {
  for (const c of [...adHocChildren]) {
    killProcessTree(c);
    adHocChildren.delete(c);
  }
}

/**
 * QD-R23 #1：终止**整棵**子进程树。
 *
 * 为什么不能裸 `child.kill()`：本文件的 MCP 服务器一律 `shell: isCmdBatch` 起
 * （`.cmd` / `.bat` 必须经 `cmd.exe`）⇒ 杀掉的只是 `cmd.exe`，真正的 `npx`/`node`
 * 成为孤儿继续活着（`qd-r23-d2` 已证孙进程存活 2s+；用户的 TVPilot 就是这种形态）。
 *
 * 范式抄自本仓 `src/capabilities/shell.ts:370-388` 的 `killTree()`（PM 卡指定）：
 * win32 且有 pid ⇒ `taskkill /PID <pid> /T /F`（`/T` 连子树）；其余情况回落 `child.kill()`。
 * `killer.on('error')` 也回落 —— taskkill 不存在/被拦时不能把收尸整个丢掉。
 */
export function killProcessTree(child: ChildProcess | null | undefined): void {
  if (!child) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid != null) {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          /* 已退出：忽略 */
        }
      });
      return;
    } catch {
      // taskkill 不可用 ⇒ 落到下面的直接 kill
    }
  }
  try {
    child.kill();
  } catch {
    /* 已退出：忽略 */
  }
}

export interface McpServerConfig {
  /** 启动命令（如 npx、python、uvx），stdio 传输时必填 */
  readonly command: string;
  /** 命令参数 */
  readonly args?: readonly string[];
  /** 环境变量 */
  readonly env?: Record<string, string>;
  /** 工作目录 */
  readonly cwd?: string;
  /** 传输类型：stdio（默认）/ http / sse */
  readonly transport?: 'stdio' | 'http' | 'sse';
  /** HTTP/SSE 传输时的服务器 URL */
  readonly url?: string;
  /** HTTP/SSE 传输时的自定义请求头（如 Authorization） */
  readonly headers?: Record<string, string>;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/**
 * C1 P1 安全批 R2-02 + **P1 安全小卡（`mcp.get` 凭据面收口，2026-11-06）**。
 *
 * 缺陷史：
 *   1. R2-02：`mcp.get` 原样返回 `env` / `headers` 明文，且该工具
 *      `approvalClass:'none'`（**零审批**）→ 模型调一次就把用户的 API Key /
 *      Authorization 头原样送进模型上下文（模型是外部服务方 ⇒ 密钥外泄）。
 *   2. 本卡补的**同类残留**：`maskMcpServerSecrets` 只掩 `env` / `headers`，
 *      而 `url` / `args` **原样透出** —— `toMcpServerSummary`（F11，喂 `mcp.list`）
 *      **早就掩了这两个字段**，两处口径不一致：
 *        - `url` 可内嵌 userinfo（`https://user:pass@host`）或
 *          `?token=` 形查询参数；
 *        - `args` 可内嵌 `--token xxx` / `--api-key=xxx`。
 *      而这套值会经 **页内只读弹窗**（`studio-mcp-dialog.ts`，与站点 JS **同 world**）
 *      渲染进 DOM ⇒ 站点脚本可读；同时也进**模型上下文**。
 *
 * ── 为什么当初是有意不掩，现在必须改 ──
 *
 * 原注释的理由是「掩掉会让**编辑弹窗**无法显示地址，`headers` 才是标准放密钥的地方」。
 * 但那个取舍的前提是「`mcp.get` 服务的调用方需要真值回填」；**现在的调用方是页内只读弹窗
 * 与模型**（工作台编辑器走 HTTP `/v1/mcp/servers*` + Bearer，不经本工具）——
 * **前提变了，取舍没跟着变，就成了泄漏口**。
 *
 * ⚠️ **掩码必须与 `mergeMaskedSecrets` 成对**：多掩一个字段而不加对应的还原，
 * `mcp.get` → `mcp.save` 这条**同样零审批**的回路就会把 `****` 写回磁盘，
 * 把「防外泄」变成「毁配置」（R2-02 引入过一模一样的新缺陷）。见 `mergeMaskedSecrets`。
 *
 * 口径与 F11 对齐：**复用** `maskMcpServerUrl` / `maskMcpServerArgs`，
 * 不写第二套掩码实现（两套口径必然漂移）。
 */
export const MCP_SECRET_MASK = '****';

/**
 * 把凭据字段掩码，返回新对象（不改原配置）。
 *
 * 掩码：`env` / `headers` 的**值**、`url` 的凭据部分、`args` 的凭据参数值。
 * 保留：键名 / 参数名 / 用户名 / 主机 / 路径（「需要配什么」不是秘密，「值」才是）。
 */
export function maskMcpServerSecrets(cfg: McpServerConfig): McpServerConfig {
  const maskRecord = (rec: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!rec) return undefined;
    const out: Record<string, string> = {};
    for (const key of Object.keys(rec)) {
      out[key] = MCP_SECRET_MASK;
    }
    return out;
  };
  return {
    ...cfg,
    ...(cfg.env ? { env: maskRecord(cfg.env) } : {}),
    ...(cfg.headers ? { headers: maskRecord(cfg.headers) } : {}),
    // P1 小卡：与 F11（`toMcpServerSummary`）同口径、同函数
    ...(cfg.url !== undefined ? { url: maskMcpServerUrl(cfg.url) } : {}),
    ...(cfg.args ? { args: maskMcpServerArgs(cfg.args) } : {}),
  };
}

/**
 * R2-02 防毁配置：把「掩码占位」还原成磁盘上的**原值**。
 *
 * ── 为什么必须有这一步 ──
 *
 * `mcp.get` 现在返回掩码后的配置（`env` / `headers` 的值 = `****`）。
 * 而 UI 的编辑弹窗用 `mcp.get` 回填表单 → 表单里躺的是 `****` →
 * 用户点「保存」→ `mcp.save` 收到 `****` → **原样写回磁盘** →
 * **用户真实的 API Key / Authorization 头被永久覆盖成 `****`**。
 *
 * 这就是「掩码引入的新缺陷」——挡住了外泄，却毁了配置。
 * 本函数让「掩码占位」在写回时**还原成原值**：只有**用户真的改过的值**才覆盖。
 *
 * 口径：
 *   - 入参值 === `****` 且磁盘上该 key 有原值 → **保留原值**（不改）；
 *   - 入参值 === `****` 且磁盘上该 key 不存在 → **拒写**（`ok:false`，详见 `mergeMaskedSecretsChecked`）；
 *   - 入参值是别的值（含空串 = 用户主动清空）→ **用入参值**（用户确实改了）。
 */
export function mergeMaskedSecrets(
  incoming: McpServerConfig,
  existing: McpServerConfig | null | undefined,
): McpServerConfig {
  const r = mergeMaskedSecretsChecked(incoming, existing);
  if (r.ok) return r.config;
  // 兼容入口无法表达「拒写」→ 抛错。**绝不静默把 `****` 写回磁盘**。
  throw new Error(`unresolved-mask: ${r.detail}`);
}

/** env / headers 的逐键还原（R2-02 原有语义）。
 *
 * P2 小卡（2026-11-06）：下列两种情况**收集**到 `issues` 里由调用方**拒写**，
 * 而不是把 `****` 当值写回磁盘 —— 理由见 `mergeMaskedSecretsChecked` 的文档。
 * `issues` 省略时（兼容旧签名）行为退化为「原样保留掩码」，仅供只读场景使用。
 */
function mergeEnvHeaders(
  incoming: McpServerConfig,
  existing: McpServerConfig | null | undefined,
  issues?: string[],
): McpServerConfig {
  if (!existing) return incoming;
  const restore = (
    next: Record<string, string> | undefined,
    prev: Record<string, string> | undefined,
    field: 'env' | 'headers',
  ): Record<string, string> | undefined => {
    if (!next) return next;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (v === MCP_SECRET_MASK) {
        if (prev && Object.prototype.hasOwnProperty.call(prev, k)) {
          // 掩码占位 → 还原成磁盘上的原值（不覆盖用户真实密钥）。
          out[k] = prev[k] as string;
          continue;
        }
        // P2 小卡：磁盘上没有这个 key ⇒ **无处可还原**。
        //
        // 旧行为是把字面 `****` 当值写进磁盘 —— 那不是「如实记录」，是**造了一个假凭据**：
        // 之后它被当真值使用，认证必失败，而日志里看不出这是掩码残留
        // （用户只会看到「密钥无效」，然后一遍遍重填）。
        // 现在：记进 issues，由 checked 版本返回 `ok:false` 拒写（fail-closed）。
        if (issues) {
          // F3（PM 复核）：detail 会经 `desktop-host.ts:786-789` 打日志并**返回给模型**，
          // 所以必须写「下一步该做什么」——只说「不能还原」，模型只会重试同一个请求。
          issues.push(`${field}.${k} 是掩码但磁盘上没有该键可还原；请在表单里重新填写 ${field}.${k} 的真实值后再保存`);
        }
        out[k] = v;
        continue;
      }
      out[k] = v;
    }
    return out;
  };
  return {
    ...incoming,
    ...(incoming.env ? { env: restore(incoming.env, existing.env, 'env') } : {}),
    ...(incoming.headers ? { headers: restore(incoming.headers, existing.headers, 'headers') } : {}),
  };
}

/** `mergeMaskedSecrets` 的**可判别**版本：歧义时显式失败，供写盘路径使用。 */
export type MergeMaskedResult =
  | { ok: true; config: McpServerConfig }
  | { ok: false; error: 'unresolved-mask'; detail: string };

/**
 * 段级/元素级还原（PM 裁定五十一 二）：
 *   - `url`：把入参与磁盘原值都解析，**逐段**比对 —— 掩码位取磁盘该位原值；
 *   - `args`：按 **flag 名配对**（不是按下标，用户可能增删元素）；
 *   - **任何 `****` 找不到对应的磁盘真值 ⇒ 拒写**（返回 ok:false），不猜、不静默。
 */
export function mergeMaskedSecretsChecked(
  incoming: McpServerConfig,
  existing: McpServerConfig | null | undefined,
): MergeMaskedResult {
  const issues: string[] = [];
  // P2 小卡（2026-11-06）：env/headers 里「掩码但磁盘无该键」原本会把字面 `****`
  // 写回磁盘当值 —— 那不是如实记录，是造了一个**假凭据**（之后认证必失败，
  // 日志看不出是掩码残留）。现在收集成 issue 由本函数统一**拒写**（fail-closed）。
  const base = mergeEnvHeaders(incoming, existing, issues);
  const ua = mergeUrlAndArgsChecked(incoming, existing ?? undefined);
  if (!ua.ok) return { ok: false, error: 'unresolved-mask', detail: ua.detail };
  if (issues.length > 0) {
    return { ok: false, error: 'unresolved-mask', detail: issues.join('；') };
  }
  return { ok: true, config: { ...base, ...ua.patch } };
}

/** url / args 的合并补丁（段级/元素级）。 */
type UrlArgsPatch = { url?: string; args?: string[] };
type UrlArgsResult = { ok: true; patch: UrlArgsPatch } | { ok: false; detail: string };

function mergeUrlAndArgsChecked(
  incoming: McpServerConfig,
  existing: McpServerConfig | undefined,
): UrlArgsResult {
  const patch: UrlArgsPatch = {};
  // 新建服务器（磁盘上没有这台）：**没有基准** ⇒ 不做还原，也不做歧义判定。
  // 保持既有契约「新增 → 原样使用入参」（`c1p1-r202` 已锁）。入参自带 `****` 会被
  // 如实写盘 —— 那是已登记在册的 P2 项（PM 裁定五十一 三），不在本卡改。
  if (!existing) return { ok: true, patch };

  // ── url：段级合并（**原始串手术，不走 URL 重序列化**）──
  //
  // ⚠️ 为什么不能用 `new URL()` + `toString()` 重建：那会把还原出来的凭据**百分号编码**
  // （`{{PASSWORD_x}}` → `%7B%7BPASSWORD_x%7D%7D`），写回磁盘就是**另一个密码**——
  // 表面「还原成功」，实际把凭据改坏。本函数只在原串上替换掩码段，其余字节原样保留。
  if (incoming.url !== undefined) {
    if (!hasMask(incoming.url)) {
      patch.url = incoming.url; // 用户没留掩码位 → 原样
    } else {
      if (!existing?.url) {
        return { ok: false, detail: `url 含掩码位但磁盘上无对应原值：${incoming.url}` };
      }
      const r = mergeMaskedUrlRaw(incoming.url, existing.url);
      if (!r.ok) return { ok: false, detail: r.detail };
      patch.url = r.url;
    }
  }

  // ── args：按 flag 名配对 ──
  if (incoming.args && incoming.args.some((a) => a.includes(MCP_SECRET_MASK))) {
    if (!existing?.args) {
      return { ok: false, detail: 'args 含掩码位但磁盘上无对应原值' };
    }
    const diskByFlag = collectArgValuesByFlag(existing.args);
    const merged = [...incoming.args];
    for (let i = 0; i < merged.length; i += 1) {
      const cur = merged[i];
      if (cur === MCP_SECRET_MASK) {
        // `--flag ****` 形态：值在当前位置，flag 在前一个元素
        const flag = i > 0 ? normalizeSecretName(merged[i - 1]) : '';
        const diskVal = flag ? diskByFlag.get(flag) : undefined;
        if (diskVal === undefined) {
          return { ok: false, detail: `args[${i}] 是掩码，但找不到可配对的 flag（前一个元素=${merged[i - 1] ?? '(无)'}）` };
        }
        merged[i] = diskVal;
        continue;
      }
      if (!cur.includes(MCP_SECRET_MASK)) continue;
      // `--flag=****` 形态：值与 flag 同元素
      const eq = cur.indexOf('=');
      if (eq <= 0) {
        return { ok: false, detail: `args[${i}] 含掩码但无法识别 flag 形态：${cur}` };
      }
      const flag = normalizeSecretName(cur.slice(0, eq));
      const diskVal = diskByFlag.get(flag);
      if (diskVal === undefined) {
        return { ok: false, detail: `args 的 ${cur.slice(0, eq)} 是掩码，但磁盘上没有同 flag 的原值可还原` };
      }
      merged[i] = `${cur.slice(0, eq + 1)}${diskVal}`;
    }
    if (merged.some((a) => a.includes(MCP_SECRET_MASK))) {
      return { ok: false, detail: `args 合并后仍残留掩码位：${merged.join(' ')}` };
    }
    patch.args = merged;
  }

  return { ok: true, patch };
}

/** url 里是否含掩码位（**按原始串判断**，不做 URL 解析）。 */
function hasMask(s: string): boolean {
  return s.includes(MCP_SECRET_MASK);
}

/**
 * url 的**原始串**段级还原（不经过 `new URL().toString()`）。
 *
 * 为什么必须绕开 URL 重序列化：`toString()` 会把 userinfo / query 里的特殊字符
 * **百分号编码**，还原成 `%7B%7BPASSWORD_x%7D%7D` 写回磁盘就成了**另一个密码**——
 * 表面「还原成功」、实际改坏凭据。这里逐段在**原串**上替换，保留其余字节。
 */
function mergeMaskedUrlRaw(
  incomingUrl: string,
  diskUrl: string,
): { ok: true; url: string } | { ok: false; detail: string } {
  let out = incomingUrl;

  // ① userinfo 密码段：`scheme://user:****@host` → 取磁盘密码
  const incAuth = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s.exec(out);
  const dskAuth = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s.exec(diskUrl);
  if (!dskAuth) {
    return { ok: false, detail: `磁盘上的 url 无法解析出 authority 段：${diskUrl}` };
  }
  if (incAuth) {
    const prefix = incAuth[1];
    const authority = incAuth[2];
    const rest = incAuth[3];
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(':');
      if (colon >= 0 && userinfo.slice(colon + 1) === MCP_SECRET_MASK) {
        const diskUserinfo = dskAuth[2].slice(0, dskAuth[2].lastIndexOf('@'));
        const diskColon = diskUserinfo.indexOf(':');
        if (dskAuth[2].lastIndexOf('@') < 0 || diskColon < 0) {
          return { ok: false, detail: 'url 的密码位是掩码，但磁盘上的 url 没有密码段可还原' };
        }
        const diskPassword = diskUserinfo.slice(diskColon + 1);
        const newUserinfo = `${userinfo.slice(0, colon + 1)}${diskPassword}`;
        out = `${prefix}${newUserinfo}@${authority.slice(at + 1)}${rest}`;
      }
    }
  }

  // ② 查询参数：掩码位逐个取磁盘同名原值（原串手术，不重编码）
  const qIdx = out.indexOf('?');
  if (qIdx >= 0 && out.slice(qIdx).includes(MCP_SECRET_MASK)) {
    const head = out.slice(0, qIdx);
    const queryAndHash = out.slice(qIdx + 1);
    const hashIdx = queryAndHash.indexOf('#');
    const query = hashIdx >= 0 ? queryAndHash.slice(0, hashIdx) : queryAndHash;
    const hash = hashIdx >= 0 ? queryAndHash.slice(hashIdx) : '';
    const diskQIdx = diskUrl.indexOf('?');
    const diskQuery =
      diskQIdx >= 0
        ? (() => {
            const t = diskUrl.slice(diskQIdx + 1);
            const h = t.indexOf('#');
            return h >= 0 ? t.slice(0, h) : t;
          })()
        : '';
    const diskParams = new Map<string, string>();
    for (const pair of diskQuery.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      diskParams.set(k, eq >= 0 ? pair.slice(eq + 1) : '');
    }
    const rebuilt = query
      .split('&')
      .filter((p) => p.length > 0)
      .map((pair) => {
        const eq = pair.indexOf('=');
        const k = eq >= 0 ? pair.slice(0, eq) : pair;
        const v = eq >= 0 ? pair.slice(eq + 1) : '';
        if (v !== MCP_SECRET_MASK) return pair;
        const diskVal = diskParams.get(k);
        if (diskVal === undefined) {
          throw Object.assign(new Error(`url 的查询参数 ${k} 是掩码，但磁盘上没有同名参数可还原`), {
            unresolvedMask: true,
          });
        }
        return `${k}=${diskVal}`;
      })
      .join('&');
    out = `${head}?${rebuilt}${hash}`;
  }

  // 硬不变量：任何位置都不得残留掩码位
  if (out.includes(MCP_SECRET_MASK)) {
    return { ok: false, detail: `url 合并后仍残留掩码位：${out}` };
  }
  return { ok: true, url: out };
}

/** 从磁盘 args 收集 `flag → 值`（两种形态都收；同一 flag 取最后一个）。 */function collectArgValuesByFlag(args: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const cur = args[i];
    if (!cur.startsWith('-')) continue;
    const eq = cur.indexOf('=');
    if (eq > 0) {
      out.set(normalizeSecretName(cur.slice(0, eq)), cur.slice(eq + 1));
      continue;
    }
    const next = args[i + 1];
    if (next === undefined) continue;
    out.set(normalizeSecretName(cur), next);
  }
  return out;
}

/**
 * C1 P1 安全批 F11：`mcp.list` 返回值里的**连接串凭据**掩码。
 *
 * ── 缺陷（设计稿 F11，PM 核实成立）──
 *
 * `mcp.list` **在模型表里**（`tool-contract.ts` 的 `mcp_list` → `mcp.list`），
 * 且 `approvalClass:'none'`（**零审批**）→ 模型调一次就把每台 MCP 服务器的
 * `url` / `command` / `args` **原样送进模型上下文**。
 * 而 `url` 可能内嵌 userinfo（`https://user:pass@host`）或查询参数
 * （`?token=` / `?key=` / `?api_key=`），`args` 可能内嵌 `--token xxx` /
 * `--api-key=xxx` —— **凭据照样外泄**。
 *
 * R2-02 只堵了 `mcp.get` 那条路（`env` / `headers` 掩码）。本函数补上 `mcp.list`。
 *
 * ── 为什么「对所有入口生效」而不是「只对模型面」──
 *
 * UI 与模型**共用同一条 `/studio` 通道**（宿主按 `invocationName` 路由，
 * 没有「谁发的」这一维度）→ **按入口区分不了**，只能按**字段**一刀切掩码。
 * UI 要看原文，走本地桥的配置面（设计稿 §2.2），不为此事新开工具。
 *
 * ── 掩码口径（PM 裁定）──
 *
 *   - `url`：userinfo（`user:pass@`）→ 掩码 password；查询参数里
 *     `token` / `key` / `api_key` / `apikey` / `secret` / `password` / `access_token`
 *     / `auth` 形态的**值** → 掩码。**参数名保留**（调用方要知道配了什么）。
 *   - `args`：`--token xxx` / `--token=xxx` / `--api-key xxx` 等
 *     **凭据形态参数的值** → 掩码；`--token` 这种**参数名本身**保留。
 *   - 保留：`id` / `transport` / `toolCount` / 服务器名 / `command`
 *     （`command` 是可执行名如 `npx`，不是凭据；`args` 里的路径参数也不是凭据）。
 *
 * 掩码值沿用 `MCP_SECRET_MASK`（`****`），与 R2-02 同一常量。
 */

/** 查询参数名 → 命中即掩码其值（大小写不敏感）。 */
const SECRET_QUERY_KEYS: ReadonlySet<string> = new Set([
  'token', 'key', 'api_key', 'apikey', 'secret', 'password', 'passwd', 'pwd',
  'access_token', 'accesstoken', 'auth', 'authorization', 'credential', 'credentials',
  'session', 'sessionid', 'session_id', 'signature', 'sig', 'jwt', 'bearer',
]);

/** 命令行参数名 → 命中即掩码其值（大小写不敏感，去掉前导 `-` 与下划线/连字符归一）。 */
const SECRET_ARG_NAMES: ReadonlySet<string> = new Set([
  'token', 'key', 'api-key', 'apikey', 'api_key', 'secret', 'password', 'passwd', 'pwd',
  'access-token', 'accesstoken', 'access_token', 'auth', 'authorization', 'credential',
  'credentials', 'session', 'session-id', 'sessionid', 'session_id', 'signature', 'sig', 'jwt', 'bearer',
]);

/** 参数名归一：小写、去前导 `-`/`--`、去掉 `_` 与 `-`。 */
function normalizeSecretName(raw: string): string {
  return raw.toLowerCase().replace(/^-+/, '').replace(/[_-]/g, '');
}

/** 查询参数名归一：小写 + 去掉 `_` 与 `-`（与参数名同一套判定）。 */
function normalizeQueryName(raw: string): string {
  return raw.toLowerCase().replace(/[_-]/g, '');
}

/**
 * 掩码 URL 里的凭据：userinfo 的密码 + 凭据形态查询参数的值。
 * 非 URL / 解析失败 → 原样返回（不吞掉、不改写）。
 */
export function maskMcpServerUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 不是合法 URL：可能用户填的是模板串（如 `${MCP_URL}`）。原样返回，不猜。
    return url;
  }
  let changed = false;
  // userinfo：`https://user:pass@host` → 密码打码，用户名保留。
  if (parsed.password) {
    parsed.password = MCP_SECRET_MASK;
    changed = true;
  }
  // 查询参数：凭据形态的**值**打码，参数名保留。
  for (const name of [...parsed.searchParams.keys()]) {
    if (!SECRET_QUERY_KEYS.has(normalizeQueryName(name))) continue;
    parsed.searchParams.set(name, MCP_SECRET_MASK);
    changed = true;
  }
  return changed ? parsed.toString() : url;
}

/**
 * 掩码 args 里的凭据形态参数值。
 *
 * 两种形态都吃：
 *   - `--token xxx`（值是下一个元素）→ 只打码 `xxx`，`--token` 保留；
 *   - `--token=xxx`（值在同一元素里）→ 打码 `=xxx` 后的值。
 *
 * `--token` 后面若**没有**下一个元素（或下一个元素本身又是 `--xxx` 形态的参数名）→
 * 不打码（没有值可打码，也不猜）。
 */
export function maskMcpServerArgs(args: readonly string[] | undefined): string[] | undefined {
  if (!args) return undefined;
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    const cur = out[i];
    if (!cur.startsWith('-')) continue;
    const eq = cur.indexOf('=');
    if (eq > 0) {
      // `--name=value` 形态
      const name = normalizeSecretName(cur.slice(0, eq));
      if (SECRET_ARG_NAMES.has(name) || SECRET_ARG_NAMES.has(name.replace(/-/g, '_'))) {
        out[i] = `${cur.slice(0, eq + 1)}${MCP_SECRET_MASK}`;
      }
      continue;
    }
    // `--name value` 形态：值在下一个元素
    const name = normalizeSecretName(cur);
    if (!SECRET_ARG_NAMES.has(name) && !SECRET_ARG_NAMES.has(name.replace(/-/g, '_'))) continue;
    const next = out[i + 1];
    if (next === undefined || (next.startsWith('-') && next.length > 1)) continue;
    out[i + 1] = MCP_SECRET_MASK;
    i += 1;
  }
  return out;
}

/**
 * F11：`mcp.list` 的一台服务器「连接串」视图（凭据已掩码）。
 * 保留 `id` / `transport` / `command` / `toolCount`，掩码 `url` / `args`。
 */
export interface McpServerSummary {
  readonly id: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  /** 该服务器提供的工具数（不泄工具名以外的内容）。 */
  readonly toolCount?: number;
}

/**
 * F11：把一台 MCP 服务器的连接配置转成**可安全外发**的摘要。
 * `url` / `args` 里的凭据一律掩码；`id` / `transport` / `command` / `toolCount` 保留。
 */
export function toMcpServerSummary(
  id: string,
  cfg: McpServerConfig | null | undefined,
  toolCount?: number,
): McpServerSummary {
  if (!cfg) {
    return { id, transport: 'stdio', ...(toolCount !== undefined ? { toolCount } : {}) };
  }
  const transport = cfg.transport ?? 'stdio';
  const url = maskMcpServerUrl(cfg.url);
  const args = maskMcpServerArgs(cfg.args);
  return {
    id,
    transport,
    ...(url !== undefined ? { url } : {}),
    ...(cfg.command !== undefined ? { command: cfg.command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
  };
}

export interface McpCallResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  /** Pi Agent 风格：多模态内容数组（文本+图片） */
  readonly content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
  /** 结构化详情（工具返回的元数据） */
  readonly details?: Record<string, unknown>;
  /** 是否为错误结果 */
  readonly isError?: boolean;
}

interface McpServerConnection {
  /** stdio 传输时的子进程；HTTP 传输时为 null */
  readonly process: ChildProcess | null;
  readonly id: string;
  /** HTTP 传输时的服务器 URL */
  readonly httpUrl?: string;
  /** HTTP 传输时的自定义请求头 */
  readonly httpHeaders?: Record<string, string>;
  /** 传输类型 */
  readonly transport: 'stdio' | 'http' | 'sse';
  requestId: number;
  pendingRequests: Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>;
  tools: McpTool[];
  initialized: boolean;
  /** R1-05：进程已退出/连接已关闭，后续请求快速失败，不再空等 30s 超时。 */
  closed?: boolean;
}

function defaultConfigPath(): string {
  if (process.env.STUDIO_MCP_CONFIG) return process.env.STUDIO_MCP_CONFIG;
  // 与 saveServer 保持同一口径：先看 STUDIO_CONFIG_DIR，再回落 ~/.config。
  // 原实现只认 STUDIO_MCP_CONFIG，导致 saveServer 写到 STUDIO_CONFIG_DIR、
  // 而 loadMcpServers 从 ~/.config 读——写进去的配置永远读不回来。
  const configDir = process.env.STUDIO_CONFIG_DIR?.trim();
  if (configDir) return path.join(configDir, 'mcp-servers.json');
  return path.join(os.homedir(), '.config', 'deepseek-studio', 'mcp-servers.json');
}

/**
 * 解析 MCP 配置文件文本。抛错时由调用方决定是保留旧配置还是回落空表：
 * - loadMcpServers（首次加载）失败回落 {}；
 * - 运行期热重载失败必须保留旧连接，不能因为半写入的 JSON 把工具全清空。
 */
export function parseMcpServers(raw: string): Record<string, McpServerConfig> {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return {};
  // 标准嵌套式：{ servers: { id: cfg } }
  if (parsed.servers && typeof parsed.servers === 'object') {
    return parsed.servers as Record<string, McpServerConfig>;
  }
  // 兼容历史平铺式：顶层键（除 servers 外）当作服务器配置
  // 只接受含 command 或 url 的对象，避免把 meta/说明性键误当服务器
  const out: Record<string, McpServerConfig> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== 'servers' && v && typeof v === 'object') {
      const cfg = v as Record<string, unknown>;
      if (typeof cfg.command === 'string' || typeof cfg.url === 'string') {
        out[k] = v as McpServerConfig;
      }
    }
  }
  return out;
}

/**
 * 读取 MCP 服务器配置（**可区分失败**，批 1 第 4 件）。
 *
 * 判据（PM 裁定二十一/二十二）：**IO/解析失败必须与「空状态」可区分**。
 *   - 文件不存在（`ENOENT`）= 合法的「从未配置」→ `ok:true, servers:{}`
 *   - JSON 损坏 / 读失败 → `ok:false, error:'config-corrupt'|'config-unreadable'`
 *     **绝不**再折叠成 `{}`：折叠会让面板显示「一台都没有」，用户接着保存一台就把
 *     其余全部静默丢掉（2026-11-06 串起来的那条链）。
 *
 * 告警走 **stdout**（装版进 `sidecar-<ms>.log`）：stderr 在 `sidecar.rs` 里依赖
 * `try_clone` 成功，失败走 `inherit`，装版无控制台 ⇒ 丢失。
 */
export type McpConfigLoadError = 'config-corrupt' | 'config-unreadable';

export function loadMcpServersState(
  configPath?: string,
): { ok: true; servers: Record<string, McpServerConfig> } | { ok: false; error: McpConfigLoadError; message: string } {
  const p = configPath ?? defaultConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // 文件不存在 = 从未配置，这是**合法空状态**，不是失败
      return { ok: true, servers: {} };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[mcp-controller] level=error config-unreadable path=${p} code=${code ?? '(none)'} err=${message}`);
    return { ok: false, error: 'config-unreadable', message };
  }
  try {
    return { ok: true, servers: parseMcpServers(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 损坏必须可见：这行是「面板为什么显示配置读取失败」的唯一现场证据
    console.log(`[mcp-controller] level=error config-corrupt path=${p} err=${message}`);
    return { ok: false, error: 'config-corrupt', message };
  }
}

/**
 * 读取 MCP 服务器配置（**兼容签名**）。
 *
 * ⚠️ 失败与空状态仍在此处折叠成 `{}` —— 保留只因为既有调用方（`getMcpServer`、
 * 内部 reload 之外的历史路径）依赖该签名。**需要区分失败的新代码一律用
 * `loadMcpServersState()`**；`reload()` 已改为走后者的失败分支（损坏时保留旧连接，
 * 不再把所有连接断开）。
 */
export function loadMcpServers(configPath?: string): Record<string, McpServerConfig> {
  const r = loadMcpServersState(configPath);
  return r.ok ? r.servers : {};
}

/**
 * 读取服务器完整配置（供 UI 编辑弹窗回填）。
 * 不带 configPath 时按 defaultConfigPath() 解析；不存在返回 null。
 */
export function getMcpServer(serverId: string, configPath?: string): McpServerConfig | null {
  const all = loadMcpServers(configPath);
  const cfg = all[serverId];
  return cfg ? { ...cfg } : null;
}
/**
 * 从配置文件删除一台 MCP 服务器。
 * 兼容两种形状：标准嵌套式 { servers: {...} } 与历史平铺式 { id: {...} }。
 * 原实现直接 delete all[serverId]：对嵌套式永远删不到，界面表现为「点删除没反应，
 * 重启又回来」。抽成纯函数便于单测（工具层是 privileged，测试里过不了同意闸门）。
 */
export function removeMcpServer(serverId: string, configPath?: string): { ok: boolean; error?: string } {
  const p = configPath ?? defaultConfigPath();
  try {
    const all = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const bag = (all.servers && typeof all.servers === 'object' && !Array.isArray(all.servers))
      ? (all.servers as Record<string, unknown>)
      : all;
    if (!(serverId in bag)) return { ok: false, error: `server not found: ${serverId}` };
    delete bag[serverId];
    // 原子写（批 1 第 4 件）：ACH-02 取消点在这两行之间 → 半截写会让整个 MCP 表读成损坏
    writeFileAtomicSync(p, JSON.stringify(all, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 确保配置文件存在（dev 下不存在则创建示例配置）。
 *
 * **装版不写示例**（批 N+1，D 组，设计稿 §8.4）：装版首启不得凭空写出一份带
 * `example-filesystem`（`npx -y @modelcontextprotocol/server-filesystem <homedir>\projects`）
 * 的示例配置 —— 那是开发者的脚手架，不是用户配置。装版缺省路径只返回、不落盘。
 * dev 行为逐字节不变。
 */
export function ensureMcpConfig(configPath?: string): string {
  const p = configPath ?? defaultConfigPath();
  // 装版：不创建、不写示例（显式传入 configPath 的调用方视为已知自己要什么，仍按原样写）
  if (!configPath && isInstalledDistribution()) return p;
  try {
    if (!fs.existsSync(p)) {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 原子写（批 1 第 4 件，PM 裁定二十二 ③ 点名的第四处）：示例配置同样不能半截。
      writeFileAtomicSync(
        p,
        JSON.stringify(
          {
            servers: {
              'example-filesystem': {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', path.join(os.homedir(), 'projects')],
              },
            },
          },
          null,
          2,
        ),
      );
    }
  } catch (e) {
    // 创建失败忽略（不阻断宿主），但必须留下可 grep 的一行
    console.log(
      `[mcp-controller] level=warn ensure-mcp-config failed path=${p} err=${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return p;
}

/**
 * MCP 控制器：管理多个 MCP 服务器连接，动态注册工具，转发工具调用。
 */
// ── BUG-037：MCP SSE 传输必须按流读，不能 `await res.text()` ──────────────

/** SSE 整段读取上限（与 fetch 的 AbortSignal 同量级）。 */
export const SSE_READ_TIMEOUT_MS = 30000;

export interface ReadSseOptions {
  /** 整段读取上限（毫秒），单测可注入更小值。 */
  timeoutMs?: number;
}

/** 从 SSE 文本里取第一条带 `id` 的 JSON-RPC 响应；没有就返回 undefined（半行会被下次重试）。 */
function takeJsonRpcFromSseBuffer(buffer: string): unknown | undefined {
  for (const rawLine of buffer.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as { id?: unknown; result?: unknown };
      if (parsed && typeof parsed === 'object' && parsed.id != null) return parsed.result ?? parsed;
    } catch {
      // 半行（块边界切断）：留着，下一块拼完再解析。
    }
  }
  return undefined;
}

/**
 * 从 SSE 响应读**第一条** JSON-RPC 响应（BUG-037）。
 *
 * 为什么不能 `await res.text()`：SSE 是长连接 —— 服务端发完一条 `data:` 后**不关闭**流，
 * `text()` 只有 EOF 才 resolve → 永远拿不到，最后被 30s 超时打断，每个 SSE 工具调用都要
 * 干等 30 秒再失败（真机表现为「MCP over SSE 可用但每次调用必超时」）。
 *
 * 收尾语义（每条都有用例守着）：
 *   - 解出带 `id` 的 JSON-RPC 对象 → **立即返回**，并 cancel reader（不 cancel 会吊着连接）；
 *   - 遇到 `data: [DONE]` → 停止读取；此前没响应则抛错；
 *   - 流 EOF → 返回已解析到的响应，没有则抛 `No JSON-RPC response in SSE stream`；
 *   - 超时 → cancel reader 并抛 `MCP SSE response timed out after Nms`（**不许永久挂住**）。
 */
export async function readSseJsonRpcResponse(
  res: Response,
  opts: ReadSseOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? SSE_READ_TIMEOUT_MS;
  const reader = res.body?.getReader();
  if (!reader) throw new Error('SSE response has no body');

  const decoder = new TextDecoder();
  let buffer = '';
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const readLoop = (async (): Promise<unknown> => {
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (timedOut) throw new Error(`MCP SSE response timed out after ${timeoutMs}ms`);
          throw e;
        }
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
        const found = takeJsonRpcFromSseBuffer(buffer);
        if (found !== undefined) return found;
        if (chunk.done) {
          buffer += decoder.decode();
          const atEof = takeJsonRpcFromSseBuffer(buffer);
          if (atEof !== undefined) return atEof;
          throw new Error('No JSON-RPC response in SSE stream');
        }
        if (buffer.includes('[DONE]')) {
          throw new Error('SSE stream finished without a JSON-RPC response');
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      try { await reader.cancel(); } catch { /* 已关闭或已取消 */ }
    }
  })();

  // 超时后 readLoop 自己也会 reject（reader 被 cancel）；这里吞掉避免 unhandled rejection。
  readLoop.catch(() => { /* 见上方注释 */ });

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => { /* 已取消 */ });
      reject(new Error(`MCP SSE response timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([readLoop, deadline]);
}

/**
 * testConnection 的**单步**超时（毫秒）：initialize 与 tools/list 各一步的上限。
 * 测试可注入更小值（opts.stepTimeoutMs）以确定性地走超时分支。
 */
export const TEST_STEP_TIMEOUT_MS = 5000;

/**
 * stdio 请求超时（毫秒）。
 *
 * 可变（test-only 缝）：测试把 `ms` 临时改小即可走超时分支，不必真的等 30s。
 * 生产路径不修改它。
 */
export const MCP_REQUEST_TIMEOUT = { ms: 30_000 };



export class McpController {
  private connections = new Map<string, McpServerConnection>();
  /** BUG-027：并发 connect 去重 —— 同一 serverId 同时只允许一个连接在飞。 */
  private connecting = new Map<string, Promise<McpServerConnection | null>>();
  private servers: Record<string, McpServerConfig> = {};
  /** 本实例读写同一条配置路径，避免 load/save 各认一套环境变量。 */
  private readonly configPath: string;
  /** 上次成功加载时的 mtime；null 表示文件不存在或尚未成功读取。 */
  private configMtimeMs: number | null = null;

  constructor(configPath?: string) {
    this.configPath = configPath ?? defaultConfigPath();
    this.servers = loadMcpServers(this.configPath);
    this.configMtimeMs = this.statConfigMtime();
  }

  private statConfigMtime(): number | null {
    try {
      return fs.statSync(this.configPath).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * 惰性热重载：配置文件的 mtime 变化后，在下一次读取工具/调用工具前重新加载。
   * 无需重启 sidecar，新增 MCP 服务器（例如 Autoforge 配对后写入）即可生效。
   *
   * 解析失败时保留旧配置与旧连接：配置文件可能是编辑器半写入状态，
   * 一次坏读不应把用户正在使用的工具全部摘掉。
   */
  private refreshConfigIfChanged(): void {
    const mtime = this.statConfigMtime();
    if (mtime === this.configMtimeMs) return;

    if (mtime === null) {
      // 文件被删除：按空配置处理，断开全部旧连接。
      for (const serverId of [...this.connections.keys()]) this.disconnectServer(serverId);
      this.servers = {};
      this.configMtimeMs = null;
      return;
    }

    let next: Record<string, McpServerConfig>;
    try {
      next = parseMcpServers(fs.readFileSync(this.configPath, 'utf8'));
    } catch (err) {
      console.warn(`[mcp-controller] hot reload skipped (invalid config): ${err instanceof Error ? err.message : String(err)}`);
      // 记录 mtime，避免每次工具调用都重复刷同一条告警；文件再次变化时会重试。
      this.configMtimeMs = mtime;
      return;
    }

    for (const serverId of [...this.connections.keys()]) {
      if (!next[serverId] || JSON.stringify(next[serverId]) !== JSON.stringify(this.servers[serverId])) {
        this.disconnectServer(serverId);
      }
    }
    this.servers = next;
    this.configMtimeMs = mtime;
  }

  /** 重新加载配置 */
  reload(configPath?: string): void {
    const p = configPath ?? this.configPath;
    // 批 1 第 4 件：损坏/读失败时**保留旧配置与旧连接**，不再把所有连接断开。
    // 原实现 `next = loadMcpServers(p)` 在损坏时得到 `{}` → 下面的循环会把
    // 全部连接断掉，面板显示「一台都没有」——比「没刷新」更糟。
    const state = loadMcpServersState(p);
    if (!state.ok) {
      console.log(
        `[mcp-controller] level=warn reload-skipped ${state.error} path=${p} —— 保留现有 ${Object.keys(this.servers).length} 台配置与连接`,
      );
      return;
    }
    const next = state.servers;
    // 配置变化或服务器被删除时，旧连接必须断开；
    // 否则 connect() 会命中 initialized 的旧连接，继续用旧 URL/旧 token。
    for (const serverId of [...this.connections.keys()]) {
      if (!next[serverId] || JSON.stringify(next[serverId]) !== JSON.stringify(this.servers[serverId])) {
        this.disconnectServer(serverId);
      }
    }
    this.servers = next;
    this.configMtimeMs = (() => {
      try { return fs.statSync(p).mtimeMs; } catch { return null; }
    })();
  }

  /** 获取所有已配置的 MCP 服务器 ID */
  listServerIds(): string[] {
    this.refreshConfigIfChanged();
    return Object.keys(this.servers);
  }

  /**
   * 取本实例**当前内存态**里某台服务器的完整配置（含 env / headers 明文）。
   *
   * 与模块级 `getMcpServer(id)` 的区别：后者按 `defaultConfigPath()` 另读一份文件，
   * 若本实例是用**显式 configPath** 构造的，两者会指向不同文件。
   * C1 P1 安全批 R2-02 的「写回时还原掩码」必须读**同一份**配置，
   * 否则还原会拿错基准 → 真实密钥仍被覆盖。故此处用实例自己的状态。
   */
  getServerConfig(serverId: string): McpServerConfig | null {
    this.refreshConfigIfChanged();
    const cfg = this.servers[serverId];
    return cfg ? { ...cfg } : null;
  }

  /**
   * 连接到指定 MCP 服务器并初始化（发送 initialize + tools/list）。
   * 如果已连接且初始化完成，直接返回。
   * 支持 stdio 和 HTTP 传输。
   */
  async connect(serverId: string): Promise<McpServerConnection | null> {
    this.refreshConfigIfChanged();
    const existing = this.connections.get(serverId);
    if (existing && existing.initialized) return existing;

    const config = this.servers[serverId];
    if (!config) return null;

    const transport = config.transport ?? 'stdio';

    // BUG-027：并发 connect 同一 serverId 只能 spawn 一份 MCP server 进程。
    // 原实现每次调用都走一遍 connectStdio → 并发两次就留下两个孤儿进程。
    const inflight = this.connecting.get(serverId);
    if (inflight) return inflight;

    const pending = (async (): Promise<McpServerConnection | null> => {
      try {
        if (transport === 'http' || transport === 'sse') {
          return await this.connectHttp(serverId, config);
        }
        return await this.connectStdio(serverId, config);
      } catch (e) {
        console.error(`[mcp ${serverId}] connect failed:`, e instanceof Error ? e.message : String(e));
        this.connections.delete(serverId);
        return null;
      } finally {
        // 无论成败都从去重表移除（失败后允许重试）。
        this.connecting.delete(serverId);
      }
    })();
    this.connecting.set(serverId, pending);
    return pending;
  }

  /** stdio 传输连接 */
  private async connectStdio(serverId: string, config: McpServerConfig): Promise<McpServerConnection> {
    const isWin = process.platform === 'win32';
    // env 白名单：只透传 MCP server 运行必需的系统环境变量，避免泄露宿主 token
    const ALLOWED_ENV_KEYS = new Set([
      'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive',
      'COMPUTERNAME', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL',
      'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
      'PUBLIC', 'DRIVERDATA', 'OS', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
    ]);
    const filteredEnv: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      if (ALLOWED_ENV_KEYS.has(key.toUpperCase()) && process.env[key] !== undefined) {
        filteredEnv[key] = process.env[key] as string;
      }
    }
    // 用户配置的 env 覆盖（用户明确指定的变量允许透传）
    const finalEnv = { ...filteredEnv, ...(config.env ?? {}) };

    // Windows 上 .cmd/.bat 需要 shell 解析；其他命令直接 spawn（避免命令注入）
    const isCmdBatch = isWin && /\.(cmd|bat)$/i.test(config.command);
    const proc = spawn(config.command, config.args ?? [], {
      env: finalEnv,
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isCmdBatch,
      windowsHide: true,
    });

    const conn: McpServerConnection = {
      process: proc,
      id: serverId,
      transport: 'stdio',
      requestId: 0,
      pendingRequests: new Map(),
      tools: [],
      initialized: false,
    };

    // QD-R2-07：统一清理。exit 和 error 两条腿都要走它——
    // spawn 失败（ENOENT）时 exit 不一定触发，若只在 exit 里清理，
    // connections 表里留下一条 closed=false 的陈旧 conn，后续同 serverId 调用空等 30s。
    let cleanedUp = false;
    const cleanup = (reason: string, err?: Error) => {
      if (cleanedUp) return;
      cleanedUp = true;
      conn.closed = true;
      for (const [, p] of conn.pendingRequests) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err ?? new Error(`MCP server ${serverId}: ${reason}`));
      }
      conn.pendingRequests.clear();
      try {
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
      } catch { /* ignore */ }
      // BUG-036：连接失败后 MCP server 子进程泄漏 —— cleanup 必须收尸。
      // 进程已退出时 kill 无害；这是 exit / error / 初始化失败三条腿的公共出口。
      killProcessTree(proc); // QD-R23 #1：tree-kill（.cmd 起的 MCP 只杀 cmd 会留孤儿）
      this.connections.delete(serverId);
    };

    // P0-3 修复：spawn 失败（命令不存在 / 权限不足）必须监听 error，否则 uncaughtException 杀宿主
    proc.on('error', (err) => {
      console.error(`[mcp] spawn error for ${serverId}: ${err.message}`);
      cleanup('spawn error', err);
    });

    let buffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id != null) {
            const pending = conn.pendingRequests.get(msg.id);
            if (pending) {
              conn.pendingRequests.delete(msg.id);
              if (pending.timer) clearTimeout(pending.timer);
              if (msg.error) pending.reject(new Error(msg.error.message ?? 'MCP error'));
              else pending.resolve(msg.result);
            }
          }
        } catch { /* ignore */ }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      console.warn(`[mcp ${serverId}] stderr: ${chunk.toString().slice(0, 200)}`);
    });

    proc.on('exit', (code) => {
      console.warn(`[mcp ${serverId}] exited with code ${code}`);
      cleanup(`exited with code ${code}`);
    });

    // QD-R2-07：向已死进程 stdin 写入的 EPIPE 兜底，避免 unhandled error 事件
    proc.stdin?.on('error', () => { /* EPIPE / ECONNRESET 已在 cleanup 里 reject pending */ });

    this.connections.set(serverId, conn);
    try {
      await this.initializeConnection(conn);
    } catch (e) {
      // 初始化失败（超时 / 协议错）→ 走统一清理（含 kill），
      // 否则 MCP server 进程会留在后台泄漏（BUG-036）。
      cleanup('initialize failed', e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    return conn;
  }

  /** HTTP/SSE 传输连接 */
  private async connectHttp(serverId: string, config: McpServerConfig): Promise<McpServerConnection> {
    if (!config.url) throw new Error('HTTP transport requires url');

    const conn: McpServerConnection = {
      process: null,
      id: serverId,
      transport: config.transport ?? 'http',
      httpUrl: config.url,
      httpHeaders: config.headers,
      requestId: 0,
      pendingRequests: new Map(),
      tools: [],
      initialized: false,
    };

    this.connections.set(serverId, conn);
    await this.initializeConnection(conn);
    return conn;
  }

  /** 初始化连接（initialize + notifications/initialized + tools/list） */
  private async initializeConnection(conn: McpServerConnection): Promise<void> {
    await this.sendRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'deepseek-studio', version: '1.0.0' },
    });
    this.sendNotification(conn, 'notifications/initialized', {});
    const toolsResult = (await this.sendRequest(conn, 'tools/list', {})) as { tools?: McpTool[] };
    conn.tools = toolsResult.tools ?? [];
    conn.initialized = true;
  }

  /** 发送 JSON-RPC 请求并等待响应（stdio 或 HTTP） */
  private async sendRequest(conn: McpServerConnection, method: string, params: unknown): Promise<unknown> {
    const id = ++conn.requestId;
    const msg = { jsonrpc: '2.0', id, method, params };

    if (conn.transport === 'http' || conn.transport === 'sse') {
      return this.sendHttpRequest(conn, msg);
    }

    // stdio 传输
    return new Promise((resolve, reject) => {
      // R1-05：进程缺失/已退出时显式快速失败。原可选链 `conn.process?.stdin?.write`
      // 在 process 为 undefined 时不抛错也不写入，promise 只能干等 30s 定时器。
      if (conn.closed || !conn.process || !conn.process.stdin) {
        reject(new Error(`MCP server ${conn.id} not running`));
        return;
      }
      const timer = setTimeout(() => {
        if (conn.pendingRequests.has(id)) {
          conn.pendingRequests.delete(id);
          reject(new Error(`MCP request ${method} timed out`));
        }
      }, MCP_REQUEST_TIMEOUT.ms);
      conn.pendingRequests.set(id, { resolve, reject, timer });
      try {
        conn.process.stdin.write(JSON.stringify(msg) + '\n');
      } catch (e) {
        conn.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** HTTP 传输：POST JSON-RPC 到服务器 URL */
  private async sendHttpRequest(conn: McpServerConnection, msg: Record<string, unknown>): Promise<unknown> {
    if (!conn.httpUrl) throw new Error('HTTP connection missing url');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(conn.httpHeaders ?? {}),
    };
    const res = await fetch(conn.httpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // BUG-037：SSE 是长连接，`res.text()` 只有 EOF 才 resolve → 必超时。
      // 改成按流增量读取，拿到第一条响应即返回（收尾语义见 readSseJsonRpcResponse）。
      return readSseJsonRpcResponse(res);
    }
    const data = await res.json() as { result?: unknown; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message ?? 'MCP error');
    return data.result ?? data;
  }

  /** 发送 JSON-RPC 通知（不需要响应） */
  private sendNotification(conn: McpServerConnection, method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    if (conn.transport === 'http' || conn.transport === 'sse') {
      // HTTP 通知：fire-and-forget POST（加超时，避免挂起）
      if (conn.httpUrl) {
        fetch(conn.httpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(conn.httpHeaders ?? {}) },
          body: msg,
          signal: AbortSignal.timeout(10000),
        }).catch((err) => {
          console.debug(`[mcp] notification failed for ${conn.id}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      return;
    }
    try {
      conn.process?.stdin?.write(msg + '\n');
    } catch {
      // 忽略
    }
  }

  /**
   * 获取所有已连接 MCP 服务器的工具列表（合并去重）。
   * 自动连接尚未连接的服务器。每个服务器有独立超时，失败不阻塞其他服务器。
   */
  async getAllTools(): Promise<Array<McpTool & { serverId: string }>> {
    this.refreshConfigIfChanged();
    const allTools: Array<McpTool & { serverId: string }> = [];
    for (const serverId of Object.keys(this.servers)) {
      try {
        const conn = await Promise.race([
          this.connect(serverId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
        ]);
        if (conn) {
          for (const tool of conn.tools) {
            allTools.push({ ...tool, serverId });
          }
        } else {
          console.warn(`[mcp ${serverId}] connect timed out, skipping`);
        }
      } catch (e) {
        console.warn(`[mcp ${serverId}] getAllTools failed:`, e instanceof Error ? e.message : String(e));
      }
    }
    return allTools;
  }

  /**
   * 调用 MCP 工具。
   * @param serverId MCP 服务器 ID
   * @param toolName 工具名
   * @param args 工具参数
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.refreshConfigIfChanged();
    const conn = await this.connect(serverId);
    if (!conn) return { ok: false, error: `MCP server "${serverId}" not available` };

    try {
      const result = (await this.sendRequest(conn, 'tools/call', { name: toolName, arguments: args })) as {
        content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        isError?: boolean;
      };
      if (result.isError) {
        const text = result.content?.find((c) => c.type === 'text')?.text ?? 'Unknown MCP tool error';
        return { ok: false, error: text, isError: true };
      }

      // 提取文本内容
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // 非 JSON 文本，原样返回
      }

      // 构建 Pi Agent 风格的 content 数组（文本 + 图片）
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [];
      if (text) {
        content.push({ type: 'text', text });
      }

      // 处理 MCP 标准 image 类型 content（单张图片上限 5MB，超限截断为文本占位）
      const MAX_IMAGE_BASE64_LEN = Math.floor((5 * 1024 * 1024 * 4) / 3); // base64 约为原始 4/3
      for (const c of result.content ?? []) {
        if (c.type === 'image' && c.data) {
          if (c.data.length > MAX_IMAGE_BASE64_LEN) {
            content.push({ type: 'text', text: `[图片过大已省略：${(c.data.length * 3 / 4 / 1024 / 1024).toFixed(1)}MB，超过 5MB 上限]` });
          } else {
            const mime = c.mimeType ?? 'image/png';
            content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${c.data}` } });
          }
        }
      }

      // 处理 TVPilot 风格的 inline_bytes（在 JSON data 里，同样 5MB 上限）
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const obj = data as Record<string, unknown>;
        if (typeof obj.inline_bytes === 'string') {
          if (obj.inline_bytes.length > MAX_IMAGE_BASE64_LEN) {
            content.push({ type: 'text', text: `[图片过大已省略：${(obj.inline_bytes.length * 3 / 4 / 1024 / 1024).toFixed(1)}MB，超过 5MB 上限]` });
          } else {
            const mime = typeof obj.format === 'string' ? `image/${obj.format}` : 'image/png';
            content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${obj.inline_bytes}` } });
          }
        }
      }

      return {
        ok: true,
        data,
        content: content.length > 0 ? content : undefined,
        details: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 断开所有 MCP 服务器连接 */
  disconnectAll(): void {
    for (const serverId of [...this.connections.keys()]) {
      this.disconnectServer(serverId);
    }
  }

  /** 断开单台服务器连接，并让在途请求快速失败 */
  disconnectServer(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    try {
      killProcessTree(conn.process);
    } catch {
      // 忽略
    }
    conn.closed = true;
    for (const [, pending] of conn.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server ${serverId}: disconnected`));
    }
    conn.pendingRequests.clear();
    this.connections.delete(serverId);
  }

  /**
   * 测试 MCP 服务器连接（不保存到配置，临时连接测试）。
   * 支持 stdio 和 HTTP/SSE 传输。
   */
  async testConnection(
    config: McpServerConfig,
    opts?: { stepTimeoutMs?: number },
  ): Promise<{ ok: boolean; error?: string; tools?: string[] }> {
    const transport = config.transport ?? 'stdio';
    // 单步超时可注入（测试注入 100ms 走超时分支；生产仍是 TEST_STEP_TIMEOUT_MS）。
    const stepTimeoutMs = opts?.stepTimeoutMs ?? TEST_STEP_TIMEOUT_MS;
    if (transport === 'http' || transport === 'sse') {
      return this.testHttpConnection(config);
    }
    if (!config.command) {
      return { ok: false, error: 'command is required for stdio transport' };
    }
    // R2-04：把 spawn 出来的进程挂到 try 外面，finally 才能收尸。
    let spawnedProc: ChildProcess | null = null;
    try {
      const isWin = process.platform === 'win32';
      const isCmdBatch = isWin && /\.(cmd|bat)$/i.test(config.command);
      // 复用 connectStdio 的 env 白名单逻辑
      const ALLOWED_ENV_KEYS = new Set([
        'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive',
        'COMPUTERNAME', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL',
        'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
        'PUBLIC', 'DRIVERDATA', 'OS', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
      ]);
      const filteredEnv: Record<string, string> = {};
      for (const key of Object.keys(process.env)) {
        if (ALLOWED_ENV_KEYS.has(key.toUpperCase()) && process.env[key] !== undefined) {
          filteredEnv[key] = process.env[key] as string;
        }
      }
      const proc = spawn(config.command, config.args ?? [], {
        env: { ...filteredEnv, ...(config.env ?? {}) },
        cwd: config.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isCmdBatch,
        windowsHide: true,
      });

      spawnedProc = proc;
      // QD-R23 #1：登记进收尸可达集合（__test__ 从不进 connections map）
      adHocChildren.add(proc);
      const conn: McpServerConnection = {
        process: proc,
        id: '__test__',
        transport: 'stdio',
        requestId: 0,
        pendingRequests: new Map(),
        tools: [],
        initialized: false,
      };

      // P0-3 修复：testConnection 的 spawn 也要 error 监听，否则命令不存在直接杀宿主
      proc.on('error', (err) => {
        console.error(`[mcp] testConnection spawn error: ${err.message}`);
        for (const [, req] of conn.pendingRequests) {
          if (req.timer) clearTimeout(req.timer);
          req.reject(err);
        }
        conn.pendingRequests.clear();
      });

      let buffer = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.id && conn.pendingRequests.has(msg.id)) {
              const pending = conn.pendingRequests.get(msg.id);
              conn.pendingRequests.delete(msg.id);
              // BUG-038：响应到了就必须清掉那 5000ms 超时句柄，否则它一直挂着。
              if (pending?.timer) clearTimeout(pending.timer);
              pending?.resolve(msg);
            }
          } catch { /* ignore */ }
        }
      });

      // 等待进程启动
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (proc.killed || proc.exitCode !== null) {
        return { ok: false, error: `process exited with code ${proc.exitCode}` };
      }

      // 发送 initialize
      const initResult = await new Promise<any>((resolve, reject) => {
        const id = ++conn.requestId;
        const timer = setTimeout(() => {
          conn.pendingRequests.delete(id);
          reject(new Error('initialize timeout'));
        }, stepTimeoutMs);
        conn.pendingRequests.set(id, { resolve, reject, timer });
        proc.stdin?.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'studio-test', version: '1.0' } },
        }) + '\n');
      });

      if (!initResult.result) {
        killProcessTree(proc); // QD-R23 #1：同上，tree-kill
        return { ok: false, error: 'initialize failed' };
      }

      // 发送 initialized 通知
      proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // 发送 tools/list
      const toolsResult = await new Promise<any>((resolve, reject) => {
        const id = ++conn.requestId;
        const timer = setTimeout(() => {
          conn.pendingRequests.delete(id);
          reject(new Error('tools/list timeout'));
        }, stepTimeoutMs);
        conn.pendingRequests.set(id, { resolve, reject, timer });
        proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n');
      });

      const toolNames = (toolsResult.result?.tools ?? []).map((t: any) => t.name);
      return { ok: true, tools: toolNames };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      // R2-04：无论成功/失败/超时/异常，子进程都必须收掉 ——
      // 原实现只有两条显式 kill 路径（initialize 失败 / 正常结束），
      // 超时与异常分支会把 MCP server 进程留在后台泄漏。
      if (spawnedProc) {
        adHocChildren.delete(spawnedProc); // 已收尸 ⇒ 从登记表移除，防集合长期膨胀
        killProcessTree(spawnedProc);
      }
    }
  }

  /** HTTP/SSE 传输连接测试 */
  private async testHttpConnection(config: McpServerConfig): Promise<{ ok: boolean; error?: string; tools?: string[] }> {
    if (!config.url) return { ok: false, error: 'url is required for HTTP transport' };
    const customHeaders = config.headers ?? {};
    try {
      // initialize
      const initRes = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...customHeaders },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'studio-test', version: '1.0' } },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!initRes.ok) return { ok: false, error: `HTTP ${initRes.status}: ${initRes.statusText}` };
      const initData = await initRes.json();
      if (initData.error) return { ok: false, error: initData.error.message ?? 'initialize failed' };

      // notifications/initialized（fire-and-forget，加超时）
      fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...customHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});

      // tools/list
      const toolsRes = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...customHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        signal: AbortSignal.timeout(15000),
      });
      // BUG-039：tools/list 也要查 res.ok（此前直接 json() → 500 的响应体被当成结果，
      // 报成"成功但工具列表为空"）。与上面 initialize 的检查同型。
      if (!toolsRes.ok) return { ok: false, error: `HTTP ${toolsRes.status}: ${toolsRes.statusText}` };
      const toolsData = await toolsRes.json();
      if (toolsData.error) return { ok: false, error: toolsData.error.message ?? 'tools/list failed' };
      const toolNames = (toolsData.result?.tools ?? []).map((t: any) => t.name);
      return { ok: true, tools: toolNames };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 保存 MCP 服务器配置到磁盘 */
  saveServer(serverId: string, config: McpServerConfig): { ok: boolean; error?: string } {
    try {
      const configPath = this.configPath;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      // 统一为嵌套式 { servers: { id: cfg } }
      let file: { servers: Record<string, McpServerConfig> } = { servers: {} };
      // 批 1 第 4 件（真正的丢数据路径）：原实现 `catch { /* 新文件 */ }` 把
      // **ENOENT** 与 **JSON 损坏**混为一谈 —— 文件损坏时同样从空表起写，
      // 一次保存就把用户其余 MCP 全部静默覆盖。现在两者分开：
      //   - ENOENT          → 空表合法（新文件）
      //   - 其他读错        → 拒写（config-unreadable）
      //   - JSON 解析失败    → 拒写 + 备份 `mcp-servers.json.corrupt-<ts>`（config-corrupt）
      let raw: string | null = null;
      try {
        raw = fs.readFileSync(configPath, 'utf8');
      } catch (readErr) {
        const code = (readErr as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          const message = readErr instanceof Error ? readErr.message : String(readErr);
          console.log(
            `[mcp-controller] level=error save-refused config-unreadable path=${configPath} code=${code ?? '(none)'} err=${message}`,
          );
          return { ok: false, error: 'config-unreadable' };
        }
      }
      if (raw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (parseErr) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const backup = `${configPath}.corrupt-${ts}`;
          try {
            fs.copyFileSync(configPath, backup);
          } catch (copyErr) {
            console.log(
              `[mcp-controller] level=error save-refused backup-failed path=${configPath} err=${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
            );
            return { ok: false, error: 'config-corrupt' };
          }
          console.log(
            `[mcp-controller] level=error save-refused config-corrupt path=${configPath} backup=${backup} err=${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          );
          return { ok: false, error: 'config-corrupt' };
        }
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          // 优先取 .servers；兼容历史平铺式（顶层键当作服务器）
          if (obj.servers && typeof obj.servers === 'object') {
            file.servers = obj.servers as Record<string, McpServerConfig>;
          } else {
            for (const [k, v] of Object.entries(obj)) {
              if (k !== 'servers' && v && typeof v === 'object') {
                file.servers[k] = v as McpServerConfig;
              }
            }
          }
        }
      }
      file.servers[serverId] = config;
      // 原子写（批 1 第 4 件）：半截写会让下一次 load 读成损坏。
      writeFileAtomicSync(configPath, JSON.stringify(file, null, 2));
      this.servers = file.servers;
      this.configMtimeMs = (() => {
        try { return fs.statSync(configPath).mtimeMs; } catch { return null; }
      })();
      // 覆盖已有服务器时，旧连接（尤其 HTTP 的旧 headers）不能复用。
      this.disconnectServer(serverId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** 全局单例 */
let globalController: McpController | null = null;

export function getMcpController(): McpController {
  if (!globalController) {
    globalController = new McpController();
  }
  return globalController;
}
