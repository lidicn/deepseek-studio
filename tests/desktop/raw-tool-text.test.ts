// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  continuationReasonForReply,
  hasRawToolText,
  scanRawToolText,
  stripRawToolText,
} from '../../src/inject/raw-tool-text';

/**
 * C1-F5：模型把工具调用原文当正文吐出来。
 *
 * 真机原文（`docs/验收/20261031-C1-真机取证.md` §3.6）：
 *   <search_files>{"operation":"list","root":"E:/NAS/deepseek-studio","limit":5}</search_files>
 * 这条被渲染成用户可读正文，trace 还记 `no-tools/completed`。
 *
 * 本文件锁两件事：① 各种真实形态都能被识别；② 普通文本里的 `<` 不能被误伤。
 */
describe('raw-tool-text：工具调用原文的识别与剥离', () => {
  it('真机原文：完整标签块被剥离，文本归零', () => {
    const raw = '<search_files>{"operation":"list","root":"E:/NAS/deepseek-studio","limit":5}</search_files>';
    const scan = scanRawToolText(raw);
    expect(scan.blocks).toBe(1);
    expect(scan.names).toEqual(['search_files']);
    expect(scan.unclosed).toBe(false);
    expect(scan.clean.trim()).toBe('');
    expect(hasRawToolText(raw)).toBe(true);
  });

  it('标签夹在散文里：只剥标签，散文原样保留', () => {
    const raw = '我先查一下目录。<search_files>{"operation":"list"}</search_files>查完了。';
    const scan = scanRawToolText(raw);
    expect(scan.blocks).toBe(1);
    expect(scan.clean).toBe('我先查一下目录。查完了。');
  });

  it('开标签带属性：也要剥（旧正则只认精确 `<name>`，这条是漏剥根因）', () => {
    const raw = '<search_files operation="list" root="E:/NAS">{"query":"x"}</search_files>';
    const scan = scanRawToolText(raw);
    expect(scan.blocks).toBe(1);
    expect(scan.names).toEqual(['search_files']);
    expect(scan.clean).toBe('');
  });

  it('闭合标签带空白：`</search_files >` 也算', () => {
    const scan = scanRawToolText('<search_files>{"a":1}</search_files >尾巴');
    expect(scan.blocks).toBe(1);
    expect(scan.clean).toBe('尾巴');
  });

  it('多个不同工具：各记一次，全部剥掉', () => {
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>中间<local_file_read>{"path":"a"}</local_file_read>';
    const scan = scanRawToolText(raw);
    expect(scan.blocks).toBe(2);
    expect(scan.names).toEqual(['shell_exec', 'local_file_read']);
    expect(scan.clean).toBe('中间');
  });

  it('未闭合标签（流被截断）：剥到末尾并标 unclosed', () => {
    const raw = '我准备执行 <shell_exec>{"command":"npm test"';
    const scan = scanRawToolText(raw);
    expect(scan.blocks).toBe(1);
    expect(scan.unclosed).toBe(true);
    expect(scan.clean).toBe('我准备执行 ');
  });

  it('负控：普通文本里的 < 不被误伤', () => {
    for (const text of ['a < b', '1 < 2 > 0', '表情 </3', '非工具名 <foo>bar</foo>', '<p>段落</p>']) {
      const scan = scanRawToolText(text);
      expect(scan.blocks, `不应命中：${text}`).toBe(0);
      expect(scan.clean).toBe(text);
      expect(hasRawToolText(text)).toBe(false);
    }
  });

  it('负控：仅工具名的裸词（没有尖括号）不算调用', () => {
    expect(hasRawToolText('用 search_files 找一下')).toBe(false);
  });

  it('stripRawToolText 不 trim、不改变无命中文本', () => {
    expect(stripRawToolText('  正常文本  ')).toBe('  正常文本  ');
    expect(stripRawToolText('')).toBe('');
    expect(stripRawToolText(undefined)).toBe('');
  });

  it('下划线形态的 mcp 工具名也能认（工具名单取自 SUPPORTED_INVOCATION_NAMES）', () => {
    const scan = scanRawToolText('<mcp_call>{"server":"x","tool":"y"}</mcp_call>');
    expect(scan.blocks).toBe(1);
    expect(scan.names).toEqual(['mcp_call']);
    expect(scan.clean).toBe('');
  });
});

/**
 * trace 判定：真机缺陷里 trace 记的是 `no-tools → completed`，
 * 让读者以为「只是普通问答」，实际是「模型吐了工具调用但没被执行」。
 * 这条锁住判定口径，不依赖 SSE 回放。
 */
describe('raw-tool-text：续跑判定 reason', () => {
  it('普通散文 → no-tools', () => {
    expect(continuationReasonForReply('这是正常答复，没有工具。')).toBe('no-tools');
    expect(continuationReasonForReply('')).toBe('no-tools');
    expect(continuationReasonForReply(undefined)).toBe('no-tools');
    expect(continuationReasonForReply('用 search_files 找一下（只是提到名字）')).toBe('no-tools');
  });

  it('正文里留着工具调用原文 → tool-text-unparsed（真机原文）', () => {
    const raw = '<search_files>{"operation":"list","root":"E:/NAS/deepseek-studio","limit":5}</search_files>';
    expect(continuationReasonForReply(raw)).toBe('tool-text-unparsed');
    // 夹在散文里同样成立
    expect(continuationReasonForReply(`我先看看。${raw}看完了。`)).toBe('tool-text-unparsed');
  });

  it('带属性的漏解析形态 → tool-text-unparsed', () => {
    expect(continuationReasonForReply('<search_files operation="list">{"query":"x"}</search_files>'))
      .toBe('tool-text-unparsed');
  });
});
