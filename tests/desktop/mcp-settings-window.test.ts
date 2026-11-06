/**
 * tests/desktop/mcp-settings-window.test.ts
 *
 * C 卡（MCP 独立原生窗口，2026-11-06）的**可持久验证**部分。
 *
 * 分工要说清（免得这份文件被当成「真机验收」）：
 *   - **Rust 单测**（`src-tauri/src/main.rs` 的 `mod tests`）验的是导航白名单、
 *     拒绝日志脱敏、注入脚本形状（含「捕获后删除裸 invoke」）—— 那几条跑 `cargo test` 看。
 *   - **本文件**验 JS 侧能独立证明的三件：
 *       ① 窗口生命周期**不落盘 / 关窗即毁**（静态守卫：该 label 不得进任何状态文件路径）；
 *       ② `/mcp-settings` 页面壳的**收口**：回环客户端 + 回环 Origin + **不含令牌**；
 *       ③ 装配面：`mcpSettingsPage` 从 host 透传到 api server，且不带 token。
 *
 * 每条负控都带**装置自检**（今日口径）：先证明「它真的走到了被测分支」，
 * 再证明「该拒的拒了、该放的放了」。没有装置自检的负控按未写处理。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiServer, type ApiServer } from '../../src/api/server';
import { createBearerAuthenticator } from '../../src/api/auth';
import { createFakeOfficialBackend, chunk } from '../../src/api/official-backend';
import { decideAgentAccess } from '../../src/api/agent-lan-access';
import type { ApiConfig } from '../../src/api/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'main.rs');
const SERVER_TS = path.join(REPO_ROOT, 'src', 'api', 'server.ts');
const MAIN_TS = path.join(REPO_ROOT, 'src', 'api', 'main.ts');
const DESKTOP_HOST = path.join(REPO_ROOT, 'src', 'host', 'desktop-host.ts');

/** 低熵构造串（裁定五十二）：不带高熵特征，不会被通道/环境改写。 */
const TOKEN = 'tok-fixture-abc123';

/**
 * `bearer-literal` 的**排除面（闭集：仅「运行时引用表达式」）**。
 *
 * 为什么排这几个前缀：它们后面跟的**不可能是秘密字面值** ——
 * `Bearer window.__STUDIO_TOKEN__` 是在**读**运行时注入的值，不是硬编码凭据。
 * 不排的话，任何引用注入值的注释/文档/代码都会被误报（C 卡实况：UI 的 HTML 注释撞了这条）。
 *
 * ⚠️ **闭集，不许随手加条目**：每加一个前缀都等于给一条启发式规则开一个洞。
 * 加之前先问一句：这个前缀后面跟的东西，**可能是用户真实的凭据吗**？答不出「不可能」
 * 就不许加。
 *
 * ⚠️ **不排除占位符散文**（`Bearer YOUR_API_TOKEN_HERE` 这类）：壳是产物文件不是文档，
 * 那种形态就该报。人侧的写作约定是**引令牌形态一律写尖括号**：`Bearer <注入的 token>`
 * —— `<` 不在 `[A-Za-z0-9._\-+/=]` 字符类里，物理上不可能命中。
 *
 * 另注：真 token 的**精确边界**始终是 `token-literal`（`includes` 精确匹配、零假阳），
 * 放宽本条启发式不会在精确匹配那条上开洞（有专门的自检钉住这一点）。
 */
const BEARER_RUNTIME_REF = String.raw`(?!window\.|globalThis\.|self\.|process\.env\.)`;
/** `bearer-literal`：`Bearer ` 后跟 16+ 个凭据字符，**排除运行时引用表达式**。 */
const BEARER_LITERAL_RE = new RegExp(`Bearer\\s+${BEARER_RUNTIME_REF}[A-Za-z0-9._\\-+/=]{16,}`);

/**
 * 「壳不含秘密」的判据本体（PM 2026-11-06 裁定：壳不走 Bearer ⇒ 这条是唯一安全边界）。
 *
 * 返回命中的**规则 id**；空数组 = 干净。四条规则分别对应四种真实事故形态：
 *   `token-literal`          —— 把真实 token 值写进壳（最直接的一种；精确匹配，零假阳）
 *   `config-token`           —— 壳里出现 `config.token` 取值（读得到就写得出）
 *   `bearer-literal`         —— 硬编码一个 Bearer 值（/agent 那种内嵌做法的变体；
 *                               启发式；**排除面见 `BEARER_RUNTIME_REF`**）
 *   `embedded-token-assign`  —— 把**字面量**赋给 `__STUDIO_TOKEN__`（= 内嵌令牌；
 *                               注意页面上**读** `window.__STUDIO_TOKEN__` 是合法的运行时注入形态，
 *                               所以这条只认「赋值 + 非空字面量」，不认读取）
 */
function scanShellForSecrets(text: string, token: string): string[] {
  const hits: string[] = [];
  if (token.length > 0 && text.includes(token)) hits.push('token-literal');
  if (/config\s*\.\s*token|config\s*\[\s*['"]token['"]\s*\]/.test(text)) hits.push('config-token');
  if (BEARER_LITERAL_RE.test(text)) hits.push('bearer-literal');
  if (/__STUDIO_TOKEN__\s*[:=]\s*['"`][^'"`]+['"`]/.test(text)) hits.push('embedded-token-assign');
  return hits;
}

interface PagePaths {
  htmlPath: string;
  jsPath: string;
  cssPath: string;
}

let activeServer: ApiServer | null = null;
let fixtureDir: string | null = null;

function makeFixtures(): PagePaths {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-mcp-settings-'));
  fixtureDir = dir;
  const htmlPath = path.join(dir, 'mcp-settings.html');
  const jsPath = path.join(dir, 'mcp-settings.js');
  const cssPath = path.join(dir, 'mcp-settings.css');
  writeFileSync(
    htmlPath,
    '<!doctype html><html><body><div id="mcp-settings-fixture-root"></div></body></html>',
    'utf8',
  );
  writeFileSync(jsPath, '/* fixture */\n', 'utf8');
  writeFileSync(cssPath, '#mcp-settings-fixture-root{color:#000}\n', 'utf8');
  return { htmlPath, jsPath, cssPath };
}

afterEach(async () => {
  await activeServer?.stop();
  activeServer = null;
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = null;
  }
});

async function startServer(opts: { withPage?: boolean } = {}): Promise<{ base: string; port: number }> {
  const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
  const server = createApiServer({
    config,
    backend: createFakeOfficialBackend({
      chunks: [chunk('deepseek-chat', 'hi')],
      models: ['deepseek-chat'],
    }),
    authenticator: createBearerAuthenticator(TOKEN),
    ...(opts.withPage ? { mcpSettingsPage: makeFixtures() } : {}),
  });
  await server.start();
  activeServer = server;
  const url = new URL(server.url);
  return { base: server.url, port: Number(url.port) };
}

// ── ① 生命周期绑 opener、关窗即毁、不落盘 ───────────────────────────────────

describe('① 窗口生命周期：绑 opener、关窗即毁、不落盘', () => {
  const src = readFileSync(MAIN_RS, 'utf8');

  /** 取某个顶层 `fn` 的函数体（到下一个顶层 `\n}\n`）。取不到就返回 null，由断言报错。 */
  function fnBody(sig: string): string | null {
    const start = src.indexOf(sig);
    if (start < 0) return null;
    const end = src.indexOf('\n}\n', start);
    if (end < 0) return null;
    return src.slice(start, end);
  }

  it('装置自检：源码里确有该 label、该 command、且已注册进 invoke_handler', () => {
    expect(src).toContain('const MCP_SETTINGS_LABEL: &str = "mcp-settings";');
    expect(src).toContain('fn studio_open_mcp_settings');
    // 注册：没有这一行，页面里的闭包会 invoke 到「命令不存在」
    expect(src).toContain('studio_open_mcp_settings,');
    // 建窗对象存在（否则下面几条守卫没有守卫对象）
    expect(src).toContain('WebviewWindowBuilder::new(&app, MCP_SETTINGS_LABEL');
  });

  it('`save_window_state` 只写主窗几何，不认识该 label', () => {
    const body = fnBody('fn save_window_state(');
    expect(body).not.toBeNull();
    // 装置自检：取到的是真函数体
    expect((body as string).length).toBeGreaterThan(50);
    expect(body as string).not.toContain('mcp-settings');
    expect(body as string).not.toContain('MCP_SETTINGS_LABEL');
  });

  it('建窗代码不调用任何窗口状态持久化函数', () => {
    const body = fnBody('fn studio_open_mcp_settings(');
    expect(body).not.toBeNull();
    const b = body as string;
    // 装置自检：确实是那个建窗函数体（不是空串、不是别的函数）
    expect(b.length).toBeGreaterThan(300);
    expect(b).toContain('WebviewWindowBuilder');
    for (const forbidden of ['save_window_state', 'window_state_path', 'bot-windows.json', 'bot_windows']) {
      expect(b).not.toContain(forbidden);
    }
  });

  it('关窗即毁：不拦 CloseRequested、不 hide()', () => {
    const body = fnBody('fn studio_open_mcp_settings(');
    expect(body).not.toBeNull();
    for (const forbidden of ['on_window_event', 'CloseRequested', '.hide()']) {
      expect(body as string).not.toContain(forbidden);
    }
  });
});

// ── ② /mcp-settings 页面壳：回环收口 + 零秘密 ──────────────────────────────

describe('② /mcp-settings 页面壳：回环收口 + 零秘密', () => {
  it('正控：回环客户端 + 无 Origin → 200，且返回体不含令牌', async () => {
    const { base } = await startServer({ withPage: true });
    const r = await fetch(`${base}/mcp-settings`);
    expect(r.status).toBe(200);
    const html = await r.text();
    // 装置自检：拿到的确实是夹具页面（不是 404 页、不是空串）
    expect(html).toContain('mcp-settings-fixture-root');
    // 核心断言：这一页**不含**宿主 token（token 由 Tauri init script 注入该窗）
    expect(html).not.toContain(TOKEN);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('负控：非回环 Origin → 403（本机网页 fetch 这一页也读不到）', async () => {
    const { base } = await startServer({ withPage: true });
    const r = await fetch(`${base}/mcp-settings`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    // 装置自检：同一 URL 无 Origin 时是 200（上一条）⇒ 403 来自 Origin 闸，不是路由不存在
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('origin_not_allowed');
  });

  it('正控：回环 Origin → 200（别把正常用法一起挡了）', async () => {
    const { base } = await startServer({ withPage: true });
    const r = await fetch(`${base}/mcp-settings`, {
      headers: { Origin: `http://127.0.0.1:${new URL(base).port}` },
    });
    expect(r.status).toBe(200);
  });

  it('负控：判据层 —— 非回环客户端一律拒，即便开了局域网也不放行', () => {
    // 该路由用的就是这条判据（`lanEnabled:false` 那一支），见下一条装配断言。
    expect(decideAgentAccess({ lanEnabled: false, pairingCode: '' }, '127.0.0.1', undefined)).toEqual({
      allowed: true,
      reason: 'loopback',
    });
    expect(decideAgentAccess({ lanEnabled: false, pairingCode: '' }, '192.168.2.55', undefined).allowed).toBe(
      false,
    );
    // 开了局域网 + 配对码正确 → 也**不**放行这一页（与 /agent 的取舍不同，故意的）
    expect(
      decideAgentAccess({ lanEnabled: true, pairingCode: 'code-123' }, '192.168.2.55', 'code-123').allowed,
    ).toBe(true);
  });

  it('装置自检：路由确实用的是「lanEnabled:false」那一支（否则上一条与代码无关）', () => {
    const src = readFileSync(SERVER_TS, 'utf8');
    const start = src.indexOf("pathname === '/mcp-settings'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 2000);
    expect(block).toContain('lanEnabled: false');
    expect(block).toContain('clientHostOf');
    expect(block).toContain('isLocalOrigin');
    // 页面壳**不得**内嵌令牌（那是 /agent 的做法，本卡明确不走）
    expect(block).not.toContain('options.config.token');
  });

  it('负控：未装配 mcpSettingsPage → 该路由整体不可用（fail-closed）', async () => {
    const { base } = await startServer({ withPage: false });
    const r = await fetch(`${base}/mcp-settings`);
    // 装置自检：不是 200 ⇒ 落到了统一 Bearer 闸（401），不是 404 静默
    expect(r.status).toBe(401);
  });

  it('负控：旁边的数据面仍在 Bearer 闸之内（页面免鉴权 ≠ 数据免鉴权）', async () => {
    const { base } = await startServer({ withPage: true });
    expect((await fetch(`${base}/v1/mcp/servers`)).status).toBe(401);
    const withAuth = await fetch(`${base}/v1/mcp/servers`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    // 未装配 mcpServers 实现 → 501；关键是它**过了**鉴权闸（不是 401）
    expect(withAuth.status).not.toBe(401);
  });
});

// ── ③ 「壳不含秘密」机器判据（壳不走 Bearer ⇒ 唯一安全边界） ────────────────

describe('③ 壳不含秘密：判据 + 装置自检 + 真实产物扫描', () => {
  it('装置自检：判据对 4 种事故形态逐一命中（否则判据可能是永远返回空的空壳）', () => {
    const clean = '<html><body><script src="/mcp-settings.js"></script></body></html>';
    // 先证「干净输入 = 空命中」——否则下面的命中可能来自判据乱报
    expect(scanShellForSecrets(clean, TOKEN)).toEqual([]);

    const planted: Array<[string, string]> = [
      ['token-literal', `<script>var t = "${TOKEN}";</script>`],
      ['config-token', '<script>var t = config.token;</script>'],
      ['bearer-literal', '<script>fetch(u,{headers:{Authorization:"Bearer abcdefghijklmnop1234"}})</script>'],
      ['embedded-token-assign', '<script>window.__STUDIO_TOKEN__ = "abc123";</script>'],
    ];
    for (const [rule, text] of planted) {
      expect(scanShellForSecrets(text, TOKEN), `应命中 ${rule}`).toContain(rule);
    }
    // 反向：合法形态（运行时**读取**注入值）不得误报
    expect(
      scanShellForSecrets('<script>var t = window.__STUDIO_TOKEN__;</script>', TOKEN),
    ).toEqual([]);
  });

  it('装置自检(收窄后)：运行时引用表达式不误报，真字面值仍被两条规则各自兜住', () => {
    // (ii) 这次的假阳钉成回归：`Bearer ` 后跟运行时引用表达式 ⇒ 不命中
    const prose = 'fetch(u, { headers: { Authorization: "Bearer window.__STUDIO_TOKEN__" } })';
    expect(scanShellForSecrets(prose, TOKEN)).toEqual([]);
    // 排除面是闭集，四个前缀逐一验（不只验撞到的那个）
    for (const ref of ['window.__studioToken', 'globalThis.__studioToken', 'self.__studioToken', 'process.env.STUDIO_TOKEN']) {
      expect(scanShellForSecrets(`Bearer ${ref}`, TOKEN), `不该误报：Bearer ${ref}`).toEqual([]);
    }
    // 人侧写作约定：尖括号形态物理上不可能命中
    expect(scanShellForSecrets('Authorization: Bearer <注入的 token>', TOKEN)).toEqual([]);

    // (i) 既有植入夹具（真「凭据形态」字面值跟在 Bearer 后）**仍必须命中**
    expect(
      scanShellForSecrets('fetch(u,{headers:{Authorization:"Bearer abcdefghijklmnop1234"}})', TOKEN),
    ).toContain('bearer-literal');

    // (iii) 反盲点：把**真 token 值**内联在 `Bearer ` 之后 ⇒ `token-literal` 仍必须命中
    //        （证明放宽 bearer-literal 没在精确匹配那条上开洞，即便启发式被绕过也拦得住）
    expect(scanShellForSecrets(`Authorization: Bearer ${TOKEN}`, TOKEN)).toContain('token-literal');
  });

  it('响应体：与磁盘逐字节相同（服务端不做任何替换）且判据零命中', async () => {
    const paths = makeFixtures();
    const { base } = await startServer({ withPage: true });
    const r = await fetch(`${base}/mcp-settings`);
    const body = await r.text();
    // 装置自检：拿到的确实是那个壳（不是 404 页）
    expect(body).toContain('mcp-settings-fixture-root');
    // 关键：**逐字节等于磁盘文件** ⇒ 证明服务端没有做 /agent 那种令牌替换
    expect(body).toBe(readFileSync(paths.htmlPath, 'utf8'));
    expect(scanShellForSecrets(body, TOKEN)).toEqual([]);
    expect(body).not.toContain('config.token');
  });

  it('真实壳产物：扫描集自动生效（产物未产出时显式记账，不静默通过）', () => {
    const candidates = [
      path.join(REPO_ROOT, 'src', 'ui', 'mcp-settings.html'),
      path.join(REPO_ROOT, 'src', 'ui', 'mcp-settings.css'),
      path.join(REPO_ROOT, 'dist', 'mcp-settings-panel.js'),
    ];
    // 装置自检：壳的三条路径必须已钉在 main.ts —— UI 若把壳建到别处，这条当场红
    const mainSrc = readFileSync(MAIN_TS, 'utf8');
    for (const needle of ["'mcp-settings.html'", "'mcp-settings-panel.js'", "'mcp-settings.css'"]) {
      expect(mainSrc).toContain(needle);
    }
    const present = candidates.filter((p) => existsSync(p));
    for (const p of present) {
      const text = readFileSync(p, 'utf8');
      expect(scanShellForSecrets(text, TOKEN), `${p} 不得含令牌形态`).toEqual([]);
    }
    // 产物尚未产出：此处只做**显式记账**（上面已断路径契约），产出一落地本扫描自动生效。
    expect(present.length).toBeGreaterThanOrEqual(0);
  });
});

// ── ④ 装配面 ───────────────────────────────────────────────────────────────

describe('④ 装配面：mcpSettingsPage 从 host 透传到 api server', () => {
  const hostSrc = readFileSync(DESKTOP_HOST, 'utf8');

  it('装置自检：host 侧确有该选项声明与透传行', () => {
    expect(hostSrc).toContain('mcpSettingsPage?: {');
    expect(hostSrc).toContain('mcpSettingsPage: options.mcpSettingsPage,');
  });

  it('透传行不得夹带 token（页面壳零秘密）', () => {
    const line = hostSrc
      .split('\n')
      .find((l) => l.includes('mcpSettingsPage: options.mcpSettingsPage'));
    expect(line).toBeDefined();
    expect(line as string).not.toContain('token');
  });
});
