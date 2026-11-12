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

  it('Headers 也接受 HTTP 标准写法 `KEY: VALUE`（2026-11-12 真机：此前整行被静默丢弃）', () => {
    // 两态读数：修前 RED = `indexOf('=') === -1` ⇒ continue ⇒ `{}`（Authorization 丢失 → 服务器 403）；
    // 修后 GREEN = 冒号分隔同样解析。
    expect(parseKeyValueLines('Authorization: Bearer af_5ae4d63c')).toEqual({
      Authorization: 'Bearer af_5ae4d63c',
    });
    // 混合写法（env 用等号、headers 用冒号）
    expect(parseKeyValueLines('REGION=cn\nAuthorization: Bearer x')).toEqual({
      REGION: 'cn',
      Authorization: 'Bearer x',
    });
    // 等号在前时按等号切，不会被人肉 URL 里的冒号抢走
    expect(parseKeyValueLines('URL=http://192.168.2.200:8787/mcp')).toEqual({
      URL: 'http://192.168.2.200:8787/mcp',
    });
    // 没有分隔符的行仍然忽略（不是静默丢内容，是空行/垃圾行）
    expect(parseKeyValueLines('nonsense\n')).toEqual({});
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

describe('工作台 MCP 编辑器：测试连接反馈（P1 2026-11-06）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 已填好名称/命令的表单（collectConfig 可过校验）。 */
  function openFilledForm(): { testBtn: HTMLButtonElement; status: HTMLElement } {
    fetchMock.mockResolvedValue(okResponse({}));
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountMcpEditor({ root, token: 'tok-t', origin: 'http://127.0.0.1:8760' });
    (root.querySelector('#btn-mcp-add') as HTMLButtonElement).click();
    const form = root.querySelector('#mcp-editor-form') as HTMLElement;
    const inputs = Array.from(form.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    inputs[0]!.value = 'fs';
    inputs[1]!.value = 'npx';
    const testBtn = Array.from(form.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('测试连接')) as HTMLButtonElement;
    const status = root.querySelector('#mcp-editor-status') as HTMLElement;
    return { testBtn, status };
  }

  /** 真 fetch 同形：尊重 signal，abort 后 reject（宿主长期不回包 = pending）。 */
  function pendingSignalRespectingFetch(): void {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }
        // 宿主不回包：不主动 resolve。
        void resolve;
      }),
    );
  }

  it('点「测试连接」立即 loading 态；到 15s 客户端上限宿主未回包 → 可见超时提示（含三查项）且按钮还原', async () => {
    vi.useFakeTimers();
    const { testBtn, status } = openFilledForm();
    pendingSignalRespectingFetch();
    testBtn.click();
    // 点击即有界面反应（此前「无任何反应」的修复点）
    expect(testBtn.disabled).toBe(true);
    expect(testBtn.textContent).toBe('测试中…');
    expect(status.textContent).toBe('');
    await vi.advanceTimersByTimeAsync(15_001);
    expect(status.textContent).toContain('测试超时');
    expect(status.textContent).toContain('请检查服务器 URL');
    // 按钮还原（原 label + 可点）
    expect(testBtn.disabled).toBe(false);
    expect(testBtn.textContent).toBe('测试连接');
  });

  it('测试失败时把宿主的 error.message 显示出来（此前只有 HTTP 400，看不出原因）', async () => {
    // 两态读数：修前 RED = 文案停在「连接失败（HTTP 400）」，宿主给的 `fetch failed` 被丢弃；
    // 修后 GREEN = 文案含 `fetch failed` 与状态码。
    vi.useFakeTimers();
    const { testBtn, status } = openFilledForm();
    // 必须在 openFilledForm() 之后覆盖：该 helper 内部先 mockResolvedValue（列表刷新用）。
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'mcp_test_failed', message: 'fetch failed' } }),
    });
    testBtn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toContain('fetch failed');
    expect(status.textContent).toContain('HTTP 400');
  });

  it('状态机单调锁（mock 忽略 signal）：已报超时后，迟到的成功响应不再覆盖「测试超时」文案', async () => {
    // 本用例的 fetch 是 **mock 忽略 signal**：abort 后不 reject，我们手动在 15s 之后 resolve，
    // 模拟「宿主迟到的回包」。断言对象是**面板状态机**（文案不被二次改写），不是 socket。
    // 两态读数：修前 RED = 旧实现无超时机制、该形态请求会永远挂着无反馈；
    // 若只加 loading 态而没有 timedOut 单调锁，迟到的成功会覆盖超时提示。修后 GREEN = 文案停在「测试超时」。
    vi.useFakeTimers();
    let resolveLate: (v: unknown) => void = () => {};
    const { testBtn, status } = openFilledForm();
    // pending mock 必须在 openFilledForm() **之后**设：该 helper 内部先 mockResolvedValue（列表刷新用），
    // 若先设 pending 会被它冲掉 → 「测试连接」的 fetch 立即 resolve，永远走不到超时分支（本例修前踩的坑）。
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveLate = resolve; }));
    testBtn.click();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(status.textContent).toContain('测试超时');
    // 迟到的「成功」到达 → 不得改写状态机
    resolveLate(okResponse({}));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toContain('测试超时');
    expect(status.textContent).not.toContain('连接成功');
    expect(testBtn.disabled).toBe(false);
  });

  it('校验失败给可见提示（未填名称 → 「请填写服务器名称」），不是静默返回', () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountMcpEditor({ root, token: 'tok-v', origin: 'http://127.0.0.1:8760' });
    (root.querySelector('#btn-mcp-add') as HTMLButtonElement).click();
    const form = root.querySelector('#mcp-editor-form') as HTMLElement;
    const testBtn = Array.from(form.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('测试连接')) as HTMLButtonElement;
    testBtn.click();
    return new Promise<void>((done) => setTimeout(() => {
      const status = root.querySelector('#mcp-editor-status') as HTMLElement;
      expect(status.textContent).toBe('请填写服务器名称');
      expect(testBtn.disabled).toBe(false);
      done();
    }, 0));
  });
});

/**
 * Headers 行式编辑器（2026-11-12，参考豆包「自定义连接器」）。
 *
 * 真机事故链：用户按 HTTP 标准在 Headers 文本框写 `Authorization: Bearer xxx`
 * → `parseKeyValueLines` 只认 `=` → 整行 `continue` 静默丢弃 → 保存后
 * `headers:{}` → 请求不带 Authorization → 服务器 403 → 界面零报错。
 * 治法是**让结构化数据由 UI 表达**（名称/值两栏），从根上没有「解析失败」这条分支。
 */
describe('工作台 MCP 编辑器：Headers 行式编辑器', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 挂载并打开「添加服务器」表单，传输类型切到 http。 */
  function openHttpForm(): HTMLElement {
    fetchMock.mockResolvedValue(okResponse({ servers: [] }));
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountMcpEditor({ root, token: 'tok-h', origin: 'http://127.0.0.1:8760' });
    (root.querySelector('#btn-mcp-add') as HTMLButtonElement).click();
    const form = root.querySelector('#mcp-editor-form') as HTMLElement;
    const select = form.querySelector('select') as HTMLSelectElement;
    select.value = 'http';
    select.dispatchEvent(new Event('change'));
    return form;
  }

  /** 表单里的 text 输入，按 DOM 顺序：[0]名称 [1]命令 [2]cwd [3]URL [4]Header 名称 [5]Header 值。 */
  function textInputs(form: HTMLElement): HTMLInputElement[] {
    return Array.from(form.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
  }

  function buttonByText(form: HTMLElement, text: string): HTMLButtonElement {
    return Array.from(form.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement;
  }

  it('默认一行空的「名称 / 值 / 删除」；点「添加」再加一行', () => {
    const form = openHttpForm();
    const rows = form.querySelectorAll('.mcp-editor-row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.querySelectorAll('input').length).toBe(2);
    expect(rows[0]!.querySelector('.mcp-editor-row-remove')!.textContent).toBe('删除');
    buttonByText(form, '添加').click();
    expect(form.querySelectorAll('.mcp-editor-row').length).toBe(2);
  });

  it('保存时把两栏收集成 headers 对象（Authorization 不再被丢弃）', async () => {
    vi.useFakeTimers();
    const form = openHttpForm();
    const inputs = textInputs(form);
    inputs[0]!.value = 'AutoForge';
    inputs[3]!.value = 'http://192.168.2.200:8787/mcp';
    inputs[4]!.value = 'Authorization';
    inputs[5]!.value = 'Bearer af_5ae4d63c';
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    buttonByText(form, '保存').click();
    await vi.advanceTimersByTimeAsync(0);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { config: { headers: Record<string, string>; url: string } };
    // 两态读数：修前（文本框 + 只认 `=`）这里是 {}，Authorization 整行丢失。
    expect(body.config.headers).toEqual({ Authorization: 'Bearer af_5ae4d63c' });
    expect(body.config.url).toBe('http://192.168.2.200:8787/mcp');
  });

  it('名称为空的行整行跳过（不会写出空 key）', async () => {
    vi.useFakeTimers();
    const form = openHttpForm();
    const inputs = textInputs(form);
    inputs[0]!.value = 'X';
    inputs[3]!.value = 'http://127.0.0.1:1/mcp';
    // 唯一一行：名称留空、值有内容 → 必须整行跳过
    inputs[4]!.value = '';
    inputs[5]!.value = 'orphan';
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    buttonByText(form, '保存').click();
    await vi.advanceTimersByTimeAsync(0);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      config: { headers: Record<string, string> };
    };
    expect(body.config.headers).toEqual({});
  });

  it('删掉唯一一行后自动补一行空的（否则表单上没有可填位置）', () => {
    const form = openHttpForm();
    (form.querySelector('.mcp-editor-row-remove') as HTMLButtonElement).click();
    expect(form.querySelectorAll('.mcp-editor-row').length).toBe(1);
    expect((form.querySelector('.mcp-editor-row-key') as HTMLInputElement).value).toBe('');
  });

  it('HTTP 模式隐藏 stdio 字段组；切回 stdio 再显示（参考豆包的按类型显示）', () => {
    const form = openHttpForm();
    const groupOf = (labelText: string): HTMLElement => {
      const label = Array.from(form.querySelectorAll('.mcp-editor-label'))
        .find((l) => (l.textContent ?? '').includes(labelText)) as HTMLElement;
      return label.parentElement as HTMLElement;
    };
    // HTTP：stdio 独占组必须隐藏，URL / Headers 必须可见
    expect(groupOf('启动命令').hidden).toBe(true);
    expect(groupOf('参数').hidden).toBe(true);
    expect(groupOf('工作目录').hidden).toBe(true);
    expect(groupOf('环境变量').hidden).toBe(true);
    expect(groupOf('服务器 URL').hidden).toBe(false);
    expect(groupOf('自定义 Headers').hidden).toBe(false);
    // 切回 stdio：反过来
    const select = form.querySelector('select') as HTMLSelectElement;
    select.value = 'stdio';
    select.dispatchEvent(new Event('change'));
    expect(groupOf('启动命令').hidden).toBe(false);
    expect(groupOf('服务器 URL').hidden).toBe(true);
  });
});
