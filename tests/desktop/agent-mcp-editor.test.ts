// @vitest-environment jsdom
/**
 * 工作台 MCP 编辑器（PM 2026-11-02，(B) 方案）
 *
 * 工作台是**唯一**能看见 MCP 明文的地方：
 *   - 独立 origin（`http://127.0.0.1:8760`）的**独立 webview 窗口**
 *     （`open_workbench` 用 `WebviewUrl::External` 建，不是 iframe）
 *   - DeepSeek 页面里的模型与 UI 面板同 `globalThis`，但**跨不到**本 origin
 *   - `/agent` HTML 由服务端把 `__STUDIO_TOKEN__` 替换成真令牌
 *
 * 三层断言：
 *   1. **行为层**：所有请求带 `Authorization: Bearer <token>`；端点是 `/v1/mcp/servers`；
 *      写操作走 POST/PUT + `{ id, config }`。
 *   2. **结构层**：编辑器**不 import 工具通道**（`studio-ui-core` / `callHostTool` /
 *      `sendToolCall` 一律不许出现）；端点不得挂在 `/agent` 那段免鉴权路由旁。
 *   3. **负控层**：判据对「去掉 Authorization 头」的变体必须判 false ——
 *      证明 Bearer 这条约束**有区分力**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_SERVERS_ENDPOINT,
  formatArgsLines,
  formatKeyValueLines,
  mountMcpEditor,
  parseArgsLines,
  parseKeyValueLines,
  targetOf,
  transportLabel,
} from '../../src/ui/agent-mcp-editor';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const EDITOR_SRC = path.join(REPO_ROOT, 'src', 'ui', 'agent-mcp-editor.ts');
const AGENT_PANEL_SRC = path.join(REPO_ROOT, 'src', 'ui', 'agent-panel.ts');
const FIXTURE_NO_BEARER = path.join(HERE, 'fixtures', 'mcp-editor-no-bearer.fixture.txt');

/**
 * 「请求带 Bearer」判据 —— 结构锁与负控共用同一判据。
 *
 * 只认**真实的 header 构造**：`Authorization` 与 `Bearer ${token}` 必须在**同一行**，
 * 否则注释里提到「Bearer」也算通过（那是恒真断言，没有区分力）。
 */
export function hasBearerHeader(source: string): boolean {
  return /Authorization[^;\n]*Bearer[^;\n]*\$\{token\}/.test(source);
}

/** 「端点挂在 /v1 下」判据（`/v1/*` 统一 Bearer 校验、fail-closed）。 */
export function usesV1Endpoint(source: string): boolean {
  return source.includes("'/v1/mcp/servers'");
}

/**
 * 「不经工具通道」判据 —— 只认**真实的 import / 调用形态**，
 * 不看注释里提到的那几个词（否则这条断言恒失败或恒真，没有区分力）。
 */
export function avoidsToolChannel(source: string): boolean {
  if (/from\s+['"][^'"]*studio-ui-core['"]/.test(source)) return false;
  if (/\bcallHostTool\s*\(/.test(source)) return false;
  if (/\bsendToolCall\s*\(/.test(source)) return false;
  return true;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function okResponse(payload: unknown): unknown {
  return { ok: true, status: 200, json: async () => payload };
}

describe('工作台 MCP 编辑器：纯函数', () => {
  it('KEY=VALUE 解析忽略空行与注释行', () => {
    expect(parseKeyValueLines('A=1\n\n# 注释\nB=2\n')).toEqual({ A: '1', B: '2' });
  });

  it('KEY=VALUE 解析保留值里的等号', () => {
    expect(parseKeyValueLines('TOKEN=abc=def')).toEqual({ TOKEN: 'abc=def' });
  });

  it('格式化与解析互逆', () => {
    const rec = { API_KEY: 'secret', REGION: 'cn' };
    expect(parseKeyValueLines(formatKeyValueLines(rec))).toEqual(rec);
  });

  it('参数按行拆分、去空行', () => {
    expect(parseArgsLines('-y\n  \nserver\n')).toEqual(['-y', 'server']);
    expect(formatArgsLines(['-y', 'server'])).toBe('-y\nserver');
  });

  it('传输类型与目标地址', () => {
    expect(transportLabel(undefined)).toBe('STDIO');
    expect(transportLabel('http')).toBe('HTTP');
    expect(targetOf({ url: 'https://x/mcp' })).toBe('https://x/mcp');
    expect(targetOf({ command: 'npx' })).toBe('npx');
  });
});

describe('工作台 MCP 编辑器：请求契约', () => {
  it('读取列表：GET /v1/mcp/servers + Bearer', async () => {
    fetchMock.mockResolvedValue(okResponse({ servers: [{ id: 'fs', transport: 'stdio', command: 'npx' }] }));

    const root = document.createElement('div');
    document.body.appendChild(root);
    const editor = mountMcpEditor({ root, token: 'test-token', origin: 'http://127.0.0.1:8760' });
    await editor.refresh();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8760/v1/mcp/servers');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('端点常量就是 /v1/mcp/servers', () => {
    expect(MCP_SERVERS_ENDPOINT).toBe('/v1/mcp/servers');
  });

  it('新增走 POST + { id, config }，同样带 Bearer', async () => {
    fetchMock.mockResolvedValue(okResponse({}));

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountMcpEditor({ root, token: 'tok-2', origin: 'http://127.0.0.1:8760' });

    const addBtn = root.querySelector('#btn-mcp-add') as HTMLButtonElement;
    expect(addBtn).toBeTruthy();
    addBtn.click();

    const form = root.querySelector('#mcp-editor-form') as HTMLElement;
    const idInput = form.querySelector('input[type="text"]') as HTMLInputElement;
    idInput.value = 'fs';
    const inputs = Array.from(form.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    inputs[1]!.value = 'npx';

    const saveBtn = Array.from(form.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('保存')) as HTMLButtonElement;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit).method === 'POST');
    expect(call).toBeTruthy();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8760/v1/mcp/servers');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-2');
    const body = JSON.parse(String(init.body));
    expect(body.id).toBe('fs');
    expect(body.config.command).toBe('npx');
    expect(body.config.transport).toBe('stdio');
  });
  it('编辑既有服务器时必须回传 cwd（否则保存会把 cwd 丢掉）', async () => {
    fetchMock.mockResolvedValue(okResponse({
      servers: [{ id: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], cwd: 'E:/NAS/mcp-server' }],
    }));

    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountMcpEditor({ root, token: 'tok-3', origin: 'http://127.0.0.1:8760' });
    await handle.refresh();

    const editor = root.querySelector('#mcp-editor-list') as HTMLElement;
    const editBtn = Array.from(editor.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('编辑')) as HTMLButtonElement;
    expect(editBtn).toBeTruthy();
    editBtn.click();

    const form = root.querySelector('#mcp-editor-form') as HTMLElement;
    const cwdInput = Array.from(form.querySelectorAll('input[type="text"]'))
      .find((i) => (i.previousElementSibling?.textContent ?? '').includes('cwd')) as HTMLInputElement;
    expect(cwdInput).toBeTruthy();
    expect(cwdInput.value).toBe('E:/NAS/mcp-server');

    const saveBtn = Array.from(form.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('保存')) as HTMLButtonElement;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit).method === 'PUT');
    expect(call).toBeTruthy();
    const body = JSON.parse(String((call as [string, RequestInit])[1].body));
    expect(body.config.cwd).toBe('E:/NAS/mcp-server');
  });
  it('/test 的 body 是 { config }（PM 定：body 可选，有 body 用 body、无 body 用存储；id 在 URL 里不重复带）', async () => {
    fetchMock.mockResolvedValue(okResponse({}));

    const root = document.createElement('div');
    document.body.appendChild(root);
    mountMcpEditor({ root, token: 'tok-4', origin: 'http://127.0.0.1:8760' });

    const addBtn = root.querySelector('#btn-mcp-add') as HTMLButtonElement;
    addBtn.click();
    const form = root.querySelector('#mcp-editor-form') as HTMLElement;
    const inputs = Array.from(form.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    inputs[0]!.value = 'fs';
    inputs[1]!.value = 'npx';

    const testBtn = Array.from(form.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('测试连接')) as HTMLButtonElement;
    testBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/test'));
    expect(call).toBeTruthy();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8760/v1/mcp/servers/fs/test');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-4');
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body)).toEqual(['config']);
    expect(body.config.command).toBe('npx');
  });
});

describe('工作台 MCP 编辑器：结构锁', () => {
  it('不经工具通道：不 import studio-ui-core、不调 callHostTool / sendToolCall', () => {
    const src = fs.readFileSync(EDITOR_SRC, 'utf8');
    expect(avoidsToolChannel(src)).toBe(true);
  });

  it('端点挂在 /v1 下，不挂 /agent 那段免鉴权路由旁', () => {
    const src = fs.readFileSync(EDITOR_SRC, 'utf8');
    expect(usesV1Endpoint(src)).toBe(true);
    expect(src).not.toContain("'/agent/api");
    expect(src).not.toContain("'/agent/mcp");
  });

  it('源码带 Bearer 头', () => {
    expect(hasBearerHeader(fs.readFileSync(EDITOR_SRC, 'utf8'))).toBe(true);
  });

  it('MCP 入口用可选获取：HTML 缺 #btn-mcp 时不能让整个工作台脚本崩掉', () => {
    const src = fs.readFileSync(AGENT_PANEL_SRC, 'utf8');
    // `$('btn-mcp')` 缺元素会 throw（`missing #btn-mcp`）→ agent-panel.js 整个挂掉。
    expect(src).not.toMatch(/\$\(\s*'btn-mcp'\s*\)/);
    expect(src).toContain("document.getElementById('btn-mcp')");
  });
});

describe('负控：判据能咬住缺口', () => {
  it('去掉 Authorization 头的变体必须被判为不合格（夹具）', () => {
    const broken = fs.readFileSync(FIXTURE_NO_BEARER, 'utf8');
    expect(hasBearerHeader(broken)).toBe(false);
  });

  it('运行时派生：一旦改回带 Authorization 头就应被判为合格（判据有区分力）', () => {
    const src = fs.readFileSync(EDITOR_SRC, 'utf8');
    const restored = src.replace(
      /Authorization[^;\n]*Bearer[^;\n]*\$\{token\}/,
      'Authorization: `Bearer ${token}`',
    );
    expect(hasBearerHeader(restored)).toBe(true);
  });

  it('运行时派生：一旦 import 工具通道，「不经工具通道」判据必须翻 false', () => {
    const src = fs.readFileSync(EDITOR_SRC, 'utf8');
    const broken = `import { callHostTool } from './studio-ui-core';\n${src}`;
    expect(avoidsToolChannel(broken)).toBe(false);
  });

  it('运行时派生：一旦把 MCP 入口改回 $() 强取，「不崩降级」判据必须翻 false', () => {
    const src = fs.readFileSync(AGENT_PANEL_SRC, 'utf8');
    // 用替换函数而非字符串：`$<...>` 在 String.replace 的替换串里是「命名捕获组插值」。
    const broken = src.replace(
      /document\.getElementById\('btn-mcp'\)/,
      () => "$<HTMLButtonElement>('btn-mcp')",
    );
    expect(broken).not.toBe(src);
    // 强取形态是 `$<HTMLButtonElement>('btn-mcp')`（`$` 后是类型参数，不是紧跟 `(`）。
    expect(/\$\s*<[^>]*>\(\s*'btn-mcp'\s*\)/.test(broken)).toBe(true);
  });
});
