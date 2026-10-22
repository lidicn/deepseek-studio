import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_INVOCATION_NAMES,
  UI_ONLY_INVOCATION_NAMES,
  isSupportedUpstreamTool,
  mapUpstreamToolInvocation,
} from '../../src/shared/tool-contract';
import { StreamingToolCallParser } from '../../src/inject/streaming-tool-parser';

/**
 * v2.0 G-01 / G-02 回归。
 *
 * G-01：流式解析器的标签名字符类旧为 `[a-zA-Z_][\w-]*`，不含 `.` 与 `:`，导致
 * `<settings.get>` / `<file.edit>` 这类点号 invocationName 被当作普通文本流回对话
 * （模型以为调用了工具，实际什么都没发生）。修复后字符类对齐上游 deepseek-pp 的
 * isValidToolTagName（src/core/tool/invocation.ts:187）。
 *
 * G-02：宿主早已登记 file.edit / search_files，却因 tool-contract 缺映射而对模型
 * 不可达，模型只能靠 local_file_write 整文件覆写。
 *
 * 同时锁死权限面：点号 id 可达 != 全部点号 id 都对模型开放。UI 直调表
 * （settings.get / workspace.set / policy.set / folder.pick / memory.delete 等）
 * 不得出现在 SUPPORTED_INVOCATION_NAMES，也不得过 isSupportedUpstreamTool。
 */

describe('G-01 parser charset: dotted invocationName must be reachable', () => {
  const dotNames = ['file.edit', 'mcp.list', 'mcp.call', 'shell.exec', 'file.read'];

  for (const name of dotNames) {
    it(`<${name}> should parse as one tool call`, () => {
      const p = new StreamingToolCallParser([name]);
      const r = p.feed(`<${name}>${JSON.stringify({ a: 1 })}</${name}>`);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].invocationName).toBe(name);
      expect(r.calls[0].params).toEqual({ a: 1 });
      expect(r.clean).toBe('');
    });
  }

  it('cross-chunk dotted open tag prefix should be retained for the next feed', () => {
    const p = new StreamingToolCallParser(['file.edit']);
    const first = p.feed('<file.ed');
    expect(first.calls).toHaveLength(0);
    expect(first.clean).toBe('');
    const second = p.feed('it>{"path":"a"}</file.edit>');
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].invocationName).toBe('file.edit');
  });

  it('non-tool dotted tags still pass through as text', () => {
    const p = new StreamingToolCallParser(['file.edit']);
    const r = p.feed('<div.class>hello</div>');
    expect(r.calls).toHaveLength(0);
    expect(r.clean).toBe('<div.class>hello</div>');
  });

  it('underscore tool names keep working (backward compatible)', () => {
    const p = new StreamingToolCallParser(['shell_exec', 'local_file_read']);
    const r = p.feed('<shell_exec>{"command":"echo hi"}</shell_exec>');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].invocationName).toBe('shell_exec');
  });
});

describe('G-01 permission surface: UI-only table must stay closed to the model', () => {
  it('SUPPORTED_INVOCATION_NAMES contains no UI-only key', () => {
    for (const uiOnly of UI_ONLY_INVOCATION_NAMES) {
      expect(SUPPORTED_INVOCATION_NAMES).not.toContain(uiOnly);
    }
  });

  it('isSupportedUpstreamTool rejects settings.get / workspace.set / policy.set', () => {
    expect(isSupportedUpstreamTool('settings.get')).toBe(false);
    expect(isSupportedUpstreamTool('workspace.set')).toBe(false);
    expect(isSupportedUpstreamTool('policy.set')).toBe(false);
    expect(isSupportedUpstreamTool('folder.pick')).toBe(false);
    expect(isSupportedUpstreamTool('memory.delete')).toBe(false);
    expect(isSupportedUpstreamTool('mcp.save')).toBe(false);
  });

  it('model-reachable dotted and underscore names both pass the gate', () => {
    for (const ok of ['shell_exec', 'file_edit', 'search_files', 'file.edit', 'shell.exec', 'mcp.list', 'mcp.call']) {
      expect(isSupportedUpstreamTool(ok)).toBe(true);
    }
  });

  it('UI-only names still map via mapUpstreamToolInvocation (UI path intact)', () => {
    expect(mapUpstreamToolInvocation('settings.get', {})).toEqual({ id: 'settings.get', params: {} });
    expect(mapUpstreamToolInvocation('workspace.set', { root: 'E:/x' })).toEqual({
      id: 'workspace.set',
      params: { root: 'E:/x' },
    });
  });
});

describe('G-02 file.edit / search_files mapping', () => {
  it('file_edit maps to file.edit and passes edits through', () => {
    const mapped = mapUpstreamToolInvocation('file_edit', {
      path: 'E:/a.ts',
      edits: [{ oldString: 'a', newString: 'b' }],
      dryRun: true,
    });
    expect(mapped?.id).toBe('file.edit');
    expect(mapped?.params.path).toBe('E:/a.ts');
    expect(mapped?.params.edits).toEqual([{ oldString: 'a', newString: 'b' }]);
    expect(mapped?.params.dryRun).toBe(true);
  });

  it('search_files keeps list and grep key fields', () => {
    const list = mapUpstreamToolInvocation('search_files', { operation: 'list', pattern: '*.ts', recursive: true, limit: 50 });
    expect(list?.id).toBe('search_files');
    expect(list?.params.operation).toBe('list');
    expect(list?.params.pattern).toBe('*.ts');
    expect(list?.params.recursive).toBe(true);
    expect(list?.params.limit).toBe(50);

    const grep = mapUpstreamToolInvocation('search_files', { operation: 'grep', query: 'TODO', regex: true, caseInsensitive: true });
    expect(grep?.params.operation).toBe('grep');
    expect(grep?.params.query).toBe('TODO');
    expect(grep?.params.regex).toBe(true);
    expect(grep?.params.caseInsensitive).toBe(true);
  });

  it('search_files defaults operation to list', () => {
    const mapped = mapUpstreamToolInvocation('search_files', {});
    expect(mapped?.params.operation).toBe('list');
  });
});

describe('prototype chain regression (v1.8 contract unchanged)', () => {
  it('constructor / __proto__ / toString all return null', () => {
    expect(mapUpstreamToolInvocation('constructor', {})).toBeNull();
    expect(mapUpstreamToolInvocation('__proto__', {})).toBeNull();
    expect(mapUpstreamToolInvocation('toString', {})).toBeNull();
    expect(mapUpstreamToolInvocation('valueOf', {})).toBeNull();
    expect(mapUpstreamToolInvocation('hasOwnProperty', {})).toBeNull();
    expect(isSupportedUpstreamTool('constructor')).toBe(false);
  });
});
