// @vitest-environment node
/**
 * 2026-11-13 工具执行缺陷 **A：报错文本兜底**（真机 `chat:ff7fc62f` 复盘）。
 *
 * 现场：`[9] af_catalog {"area":"客厅"}` → `[10] ok=false {"isError":true}` ——
 * **一个字节的错误文本都没有**，模型不知道错在哪，只能把同一次调用再发一遍。
 *
 * 取证链（本文件按这条链逐层锁）：
 *   1. `McpController.callTool` 只在 `content[].type === 'text'` 上取文案，且用 `??` 兜底
 *      ⇒ 服务器把错误放在非 text 段、或给的是空串/空白时，`error` 变成 `''`；
 *   2. `desktop-host.routeExecution` 把 `error` 改名 `reason` 往下送，`isError` 原样透传；
 *   3. `shared/tool-result-format` 的旧回退链**只认 `error`**，不认 `reason` ⇒ 裸 `[错误]`；
 *   4. `shared/continuation-prompt` 的 `p.error ?? 'execution failed'` 兜不住空串 ⇒ detail/summary 全空。
 *
 * 断言口径：「模型侧拿到的文本**非空且含工具名**」。工具名是这里的关键——
 * 只有 `[错误]` 或者 `execution failed` 都不算修好：模型还是不知道是哪次调用失败。
 *
 * 负控（见交卷）：拆掉 `ensureToolFailureText` 的补文本分支 ⇒ 第 1/3/4 组红；
 * 拆掉 `legacyResultText` 的 `reason` 兜底 ⇒ 第 5 条红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDesktopHost } from '../../src/host/desktop-host';
import { McpController } from '../../src/host/mcp-controller';
import {
  ensureToolFailureText,
  formatToolResultText,
  type ToolExecutionResult,
} from '../../src/shared/tool-result-format';
import { buildContinuationPrompt } from '../../src/shared/continuation-prompt';

const tmpDirs: string[] = [];

function writeMcpConfig(servers: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-toolerr-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ servers }), 'utf8');
  return file;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

/**
 * 桩 fetch：`tools/list` 返回一个工具；`tools/call` 返回**指定形态**的 isError 结果。
 * 这样走的是 `McpController.callTool` 真实入口（不是私有 helper）。
 */
function stubMcpFetch(callResult: unknown): void {
  vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: unknown }) => {
    const msg = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
    const result =
      msg.method === 'tools/list'
        ? { tools: [{ name: 'af_catalog', description: '目录', inputSchema: { type: 'object' } }] }
        : msg.method === 'tools/call'
          ? callResult
          : { protocolVersion: '2024-11-05', serverInfo: { name: 'fake' } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

async function callAfCatalog(): Promise<{ ok: boolean; error?: string; isError?: boolean; content?: unknown }> {
  const cfgPath = writeMcpConfig({
    autoforge: { command: '', args: [], env: {}, transport: 'http', url: 'http://fake/mcp' },
  });
  const ctl = new McpController(cfgPath);
  try {
    await ctl.connect('autoforge');
    return (await ctl.callTool('autoforge', 'af_catalog', { area: '客厅' })) as {
      ok: boolean;
      error?: string;
      isError?: boolean;
      content?: unknown;
    };
  } finally {
    ctl.disconnectAll();
  }
}

// ---------------------------------------------------------------- 1. controller 层

describe('A-1 McpController.callTool：isError 结果必须自述工具名', () => {
  it('错误内容只有图片段（无 text）→ error 必须含工具名与 server，不是空串', async () => {
    stubMcpFetch({ isError: true, content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] });

    const r = await callAfCatalog();

    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(typeof r.error).toBe('string');
    expect(r.error && r.error.trim().length).toBeGreaterThan(0);
    // 可定位：工具名 + 服务器 ID 都在文案里
    expect(r.error).toContain('af_catalog');
    expect(r.error).toContain('autoforge');
    // content 同时补齐：下游优先读 content
    const contentText = (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(contentText).toContain('af_catalog');
  });

  it('错误内容只有空白 text → 不许被当成"有文案"（`??` 兜不住空串的真形态）', async () => {
    stubMcpFetch({ isError: true, content: [{ type: 'text', text: '   ' }] });

    const r = await callAfCatalog();

    expect(r.ok).toBe(false);
    expect(r.error && r.error.trim().length).toBeGreaterThan(0);
    expect(r.error).toContain('af_catalog');
  });

  it('服务器给了真文案 → 原样透传（不覆盖上游信息）', async () => {
    stubMcpFetch({ isError: true, content: [{ type: 'text', text: 'unknown area: 客厅' }] });

    const r = await callAfCatalog();

    expect(r.error).toBe('unknown area: 客厅');
  });
});

// ---------------------------------------------------------------- 2. 透传到模型侧

describe('A-2 下游透传：reason→模型可见文本不许为空', () => {
  it('controller 的 error 经 routeExecution 改名 reason 后，模型侧文本非空且含工具名', async () => {
    stubMcpFetch({ isError: true, content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] });
    const controllerResult = await callAfCatalog();

    // 复刻 desktop-host.routeExecution 的返回形状（`reason: r.error`，isError 原样）
    const hostShape: ToolExecutionResult = {
      ok: false,
      reason: controllerResult.error,
      isError: true,
    };
    // executeTool 边界那道兜底
    const guarded = ensureToolFailureText('mcp.call', hostShape);
    const modelText = formatToolResultText(guarded as never);

    expect(modelText.length).toBeGreaterThan(0);
    expect(modelText).not.toBe('[错误]');
    expect(modelText).toContain('af_catalog');
    expect(modelText.startsWith('[错误] ')).toBe(true);
  });

  it('续跑 prompt 的 detail/summary：error 为空串时也要有工具名（兜不住空串的老洞）', () => {
    const prompt = buildContinuationPrompt('查客厅设备', [
      { invocationName: 'af_catalog', ok: false, error: '', result: undefined },
    ]);
    const block = prompt.slice(prompt.indexOf('<tool_results>'), prompt.indexOf('</tool_results>'));

    expect(block).toContain('af_catalog');
    // detail/summary 都不许是空串：老实现是 `p.error ?? 'execution failed'`，空串直接漏过去
    expect(block).not.toContain('"detail": ""');
    expect(block).not.toContain('"summary": ""');
  });
});

// ---------------------------------------------------------------- 3. 宿主真实入口

describe('A-3 executeTool 真实入口：失败结果带 content 文本', () => {
  it('无页时 chat-read 失败 → reason 保留，content 里有一句含工具名的人话', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('no-page-for-dom-capability');
      const text = (res.content as Array<{ type: string; text?: string }> | undefined)?.[0]?.text ?? '';
      expect(text).toContain('chat-read');
      expect(text).toContain('no-page-for-dom-capability');
    } finally {
      await host.stop();
    }
  });
});

// ---------------------------------------------------------------- 4. 共享兜底

describe('A-4 shared 兜底：ensureToolFailureText / reason 回退', () => {
  it('只有 isError、连 reason 都没有 → 文本含工具名且不是裸 [错误]', () => {
    const guarded = ensureToolFailureText('af_catalog', { ok: false, isError: true });
    const text = formatToolResultText(guarded as never);
    expect(text).toContain('af_catalog');
    expect(text).not.toBe('[错误]');
    expect(text.startsWith('[错误] ')).toBe(true);
  });

  it('已有非空 content 的失败结果 → 一字不改（不覆盖上游文案）', () => {
    const original: ToolExecutionResult = {
      ok: false,
      reason: 'boom',
      isError: true,
      content: [{ type: 'text', text: '上游自己的错误文本' }],
    };
    expect(ensureToolFailureText('af_catalog', original)).toBe(original);
  });

  it('成功结果一字不改（不碰 ok:true 的路径）', () => {
    const ok: ToolExecutionResult = { ok: true, data: { stdout: 'hi' } };
    expect(ensureToolFailureText('shell.exec', ok)).toBe(ok);
  });

  it('旧回退链认 reason（宿主侧失败只给了 reason 时不再空）', () => {
    expect(formatToolResultText({ ok: false, reason: 'no-page-for-dom-capability' })).toBe(
      'no-page-for-dom-capability',
    );
    // 既有优先级不变：error 仍压过 reason
    expect(formatToolResultText({ ok: false, error: 'boom', reason: 'ignored' })).toBe('boom');
  });
});
