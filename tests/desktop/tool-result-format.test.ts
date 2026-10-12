/**
 * v1.2 验收测试：工具结果统一格式规范 + terminate 机制
 *
 * 验收标准（来自 Pi Agent 移植第一阶段）：
 * - content/details/isError/terminate 四字段全可选，缺省回退旧格式
 * - formatToolResultText：content 优先 → 旧格式回退 → isError 加前缀
 * - shouldSkipAutoContinue：全部 terminate 才跳过，混合批次照常，空批次 fail-open
 * - buildExecExtras / buildFileReadExtras / buildErrorExtras 构造器正确性
 * - 向后兼容：旧字段 ok/data/error/reason/snapshot 未被删除
 */
import { describe, it, expect } from 'vitest';

import {
  textContent,
  joinContent,
  buildExecExtras,
  buildFileReadExtras,
  buildErrorExtras,
  formatToolResultText,
  shouldSkipAutoContinue,
  type ToolCardResult,
  type ToolExecutionResult,
} from '../../src/shared/tool-result-format';

// ---------------------------------------------------------------
// 一、joinContent：content 解析
// ---------------------------------------------------------------
describe('joinContent', () => {
  it('拼接多个 text 片段为纯文本', () => {
    expect(joinContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
  });

  it('缺省 / undefined / 空数组 → null（触发旧格式回退）', () => {
    expect(joinContent(undefined)).toBeNull();
    expect(joinContent([])).toBeNull();
  });

  it('忽略非 text 片段但保留 content「存在」语义', () => {
    const parts = [{ type: 'image', url: 'x' } as never, { type: 'text', text: 'ok' } as never];
    expect(joinContent(parts)).toBe('ok');
    // 全是非 text 片段 → 拼接为空串（表示「显式空输出」，不再回退）
    expect(joinContent([{ type: 'image' } as never])).toBe('');
  });

  it('单个空 text 片段 → 空串（显式空输出，不回退）', () => {
    expect(joinContent(textContent(''))).toBe('');
  });
});

// ---------------------------------------------------------------
// 二、formatToolResultText：content 优先（验收 #4）
// ---------------------------------------------------------------
describe('formatToolResultText — content 优先', () => {
  it('content 与 data 并存时，只显示 content，忽略 data', () => {
    const r: ToolCardResult = {
      ok: true,
      content: [{ type: 'text', text: 'FROM_CONTENT' }],
      data: { stdout: 'FROM_DATA' },
    };
    expect(formatToolResultText(r)).toBe('FROM_CONTENT');
  });

  it('content 与 error 并存时，仍以 content 为正文（错误前缀另算）', () => {
    const r: ToolCardResult = {
      ok: false,
      error: 'legacy error',
      content: [{ type: 'text', text: 'new body' }],
    };
    expect(formatToolResultText(r)).toBe('new body');
  });

  it('content 为空数组时回退旧格式', () => {
    const r: ToolCardResult = { ok: true, content: [], data: 'legacy string' };
    expect(formatToolResultText(r)).toBe('legacy string');
  });

  it('content 缺省时 100% 回退旧格式（向后兼容）', () => {
    expect(formatToolResultText({ ok: true, error: 'E' })).toBe('E');
  });
});

// ---------------------------------------------------------------
// 三、旧格式回退链（逐字节保持原行为）
// ---------------------------------------------------------------
describe('formatToolResultText — 旧格式回退链', () => {
  it('① error 优先于 data', () => {
    expect(formatToolResultText({ ok: false, error: 'boom', data: 'ignored' })).toBe('boom');
  });

  it('② data.stdout 被提取，并在失败时追加 [exit-code]', () => {
    const out = formatToolResultText({
      ok: false,
      data: { stdout: 'hello\n', stderr: '', exitCode: 3 },
    });
    expect(out).toBe('hello\n\n[exit-code] 3');
  });

  it('②b stdout 为空时返回 (empty output)', () => {
    expect(formatToolResultText({ ok: true, data: { stdout: '   ', stderr: '' } })).toBe('(empty output)');
  });

  it('②c 清洗 PowerShell CLIXML 垃圾', () => {
    const out = formatToolResultText({
      ok: true,
      data: {
        stdout: 'real',
        stderr: '#< CLIXML\r\n<Objs><S>System.Management.Automation.PSObject</S></Objs>Completed-1\nPreparing modules for first use.\nactual-stderr',
      },
    });
    expect(out).toBe('real\n\n[stderr]\nactual-stderr');
  });

  it('③ data 为字符串直接返回', () => {
    expect(formatToolResultText({ ok: true, data: 'plain' })).toBe('plain');
  });

  it('④ 其他对象走 JSON 格式化', () => {
    expect(formatToolResultText({ ok: true, data: { a: 1 } })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('data 为 null → 空串', () => {
    expect(formatToolResultText({ ok: true, data: null })).toBe('');
  });
});

// ---------------------------------------------------------------
// 四、isError 前缀
// ---------------------------------------------------------------
describe('formatToolResultText — isError 前缀', () => {
  it('isError === true → 加 "[错误] " 前缀', () => {
    const r: ToolCardResult = { ok: false, isError: true, content: textContent('磁盘满') };
    expect(formatToolResultText(r)).toBe('[错误] 磁盘满');
  });

  it('isError === false / 缺省 → 不加前缀', () => {
    expect(formatToolResultText({ ok: true, isError: false, content: textContent('x') })).toBe('x');
    expect(formatToolResultText({ ok: false, content: textContent('x') })).toBe('x');
  });

  it('旧格式 ok:false 不受影响（零文案变化）', () => {
    expect(formatToolResultText({ ok: false, error: 'legacy' })).toBe('legacy');
  });

  it('isError === true 但正文为空 → 仅 "[错误]"', () => {
    expect(formatToolResultText({ ok: false, isError: true, content: textContent('') })).toBe('[错误]');
  });
});

// ---------------------------------------------------------------
// 五、shouldSkipAutoContinue：terminate 闸门（验收 #5）
// ---------------------------------------------------------------
describe('shouldSkipAutoContinue', () => {
  it('全部 terminate → 跳过续跑', () => {
    expect(shouldSkipAutoContinue([{ terminate: true }, { terminate: true }])).toBe(true);
  });

  it('混合批次 → 不跳过（Pi Agent 语义）', () => {
    expect(shouldSkipAutoContinue([{ terminate: true }, { terminate: false }])).toBe(false);
    expect(shouldSkipAutoContinue([{ terminate: true }, {}])).toBe(false);
  });

  it('全部缺省 terminate → 不跳过', () => {
    expect(shouldSkipAutoContinue([{}, {}])).toBe(false);
  });

  it('单个 terminate:true → 跳过', () => {
    expect(shouldSkipAutoContinue([{ terminate: true }])).toBe(true);
  });

  it('空批次 → 不跳过（fail-open）', () => {
    expect(shouldSkipAutoContinue([])).toBe(false);
  });

  it('null / undefined 条目视为未声明终止 → 不跳过', () => {
    expect(shouldSkipAutoContinue([null, { terminate: true }])).toBe(false);
    expect(shouldSkipAutoContinue([undefined])).toBe(false);
  });

  it('非严格 true（truthy 字符串）不算终止', () => {
    expect(shouldSkipAutoContinue([{ terminate: 'true' } as never])).toBe(false);
    expect(shouldSkipAutoContinue([{ terminate: 1 } as never])).toBe(false);
  });
});

// ---------------------------------------------------------------
// 六、build* 构造器（验收 #8 / #9）
// ---------------------------------------------------------------
describe('buildExecExtras — shell.exec / python.exec', () => {
  it('成功结果 content = [{type:"text",text:stdout}]，details 含 exitCode/durationMs/cwd', () => {
    const ex = buildExecExtras({
      stdout: 'hello world',
      exitCode: 0,
      durationMs: 42,
      cwd: '/w',
      argv: ['echo hi'],
    });
    expect(ex.content).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(ex.details?.exitCode).toBe(0);
    expect(ex.details?.durationMs).toBe(42);
    expect(ex.details?.cwd).toBe('/w');
    expect(ex.details?.argv).toEqual(['echo hi']);
    expect(ex.isError).toBe(false);
  });

  it('cwd / argv 缺省时不写入 details', () => {
    const ex = buildExecExtras({ stdout: '', exitCode: 1, durationMs: 5 });
    expect(ex.details).toEqual({ exitCode: 1, durationMs: 5 });
  });
});

describe('buildFileReadExtras — file.read', () => {
  it('成功结果 content = [{type:"text",text:文件内容}]，details 含 path/size', () => {
    const ex = buildFileReadExtras({ content: 'file body', path: '/a.txt', size: 9, offset: 0, limit: 100 });
    expect(ex.content).toEqual([{ type: 'text', text: 'file body' }]);
    expect(ex.details?.path).toBe('/a.txt');
    expect(ex.details?.size).toBe(9);
    expect(ex.details?.offset).toBe(0);
    expect(ex.details?.limit).toBe(100);
    expect(ex.isError).toBe(false);
  });
});

describe('buildErrorExtras', () => {
  it('isError=true，details 带 code，content 是错误描述', () => {
    const ex = buildErrorExtras({ message: 'ENOENT', code: 'ENOENT', details: { path: '/x' } });
    expect(ex.isError).toBe(true);
    expect(ex.content).toEqual([{ type: 'text', text: 'ENOENT' }]);
    expect(ex.details?.code).toBe('ENOENT');
    expect(ex.details?.path).toBe('/x');
  });
});

// ---------------------------------------------------------------
// 七、向后兼容：旧字段未被删除（验收 #6）
// ---------------------------------------------------------------
describe('向后兼容', () => {
  it('ToolExecutionResult 仍接受 ok/reason/data/snapshot', () => {
    const r: ToolExecutionResult = {
      ok: true,
      reason: 'r',
      data: { any: 1 },
      snapshot: { total: 2, byKind: { a: 1, b: 1 } },
    };
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('r');
    expect(r.snapshot?.total).toBe(2);
  });

  it('ToolCardResult 仍接受 ok/data/error', () => {
    const r: ToolCardResult = { ok: false, data: 'd', error: 'e' };
    expect(r.error).toBe('e');
  });

  it('新旧字段可同时存在，互不覆盖', () => {
    const r: ToolCardResult = {
      ok: true,
      data: { stdout: 'old' },
      error: undefined,
      content: textContent('new'),
      details: { exitCode: 0 },
      isError: false,
      terminate: true,
    };
    expect(r.data).toEqual({ stdout: 'old' });
    expect(formatToolResultText(r)).toBe('new');
  });
});
