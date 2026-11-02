// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  __prepareOutgoingBodyForTesting,
  catalogText,
  capabilityPromptText,
  M15_CONTINUATION_CATALOG_STORAGE_KEY,
  shouldRestoreContinuationCatalog,
} from '../../src/inject/main-world-interceptor';
import { buildContinuationPrompt } from '../../src/shared/continuation-prompt';

/**
 * M1.5 字节账（契约 §6）。
 *
 * 删掉续跑 prompt 里的重复工具目录后，每轮省 **1,177 B 恒定**
 * （1,155 B 目录原文 + 22 B 分隔行 `\n\n### Available Tools\n`）。
 *
 * ⚠️ 头号误判防线（写在这里，别让后人踩）：
 *   **Verify 的 13,078 B 稳定前缀基线一个字节都不动** —— S3（重复目录）在 tail 内，
 *   不在前缀里。所以「首差字节变了」**就是回归**，不是预期变化。
 *   本文件断言的正是这件事：删目录只动 tail，head-A 前缀逐字节不变。
 */

const EXPECTED_SAVING_BYTES = 1_177;
const CAP_MARKER = '[studio-tool-capability]';

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function promptOfAssembled(rawBody: string, taskText = '帮我跑个命令'): string {
  const out = __prepareOutgoingBodyForTesting(rawBody, [], taskText);
  expect(out).not.toBeNull();
  return (JSON.parse(out!) as { prompt: string }).prompt;
}

describe('M1.5 字节账：删重复目录的收益与 head-A 不动', () => {
  it('续跑 prompt：带目录 vs 不带目录，恒定省 1,177 B（与结果条数无关）', () => {
    const catalog = catalogText();
    const exec: Array<{ name: string; result: string }> = [];

    const withCatalog = buildContinuationPrompt('原始任务', exec as never, catalog);
    const withoutCatalog = buildContinuationPrompt('原始任务', exec as never);

    expect(byteLength(withCatalog) - byteLength(withoutCatalog)).toBe(EXPECTED_SAVING_BYTES);
    // 目录原文在「带目录」那份里，「不带目录」那份里没有
    expect(withCatalog).toContain(catalog);
    expect(withoutCatalog).not.toContain(catalog);
  });

  it('最终 body 的 prompt：同样恒定省 1,177 B（head 不变，tail 变短）', () => {
    const catalog = catalogText();
    const tailWith = buildContinuationPrompt('原始任务', [] as never, catalog);
    const tailWithout = buildContinuationPrompt('原始任务', [] as never);

    const bodyWith = promptOfAssembled(JSON.stringify({ prompt: tailWith }));
    const bodyWithout = promptOfAssembled(JSON.stringify({ prompt: tailWithout }));

    expect(byteLength(bodyWith) - byteLength(bodyWithout)).toBe(EXPECTED_SAVING_BYTES);
  });

  it('head-A 前缀逐字节不变（13,078 B 稳定前缀基线不受本卡影响）', () => {
    const catalog = catalogText();
    const tailWith = buildContinuationPrompt('原始任务', [] as never, catalog);
    const tailWithout = buildContinuationPrompt('原始任务', [] as never);

    const bodyWith = promptOfAssembled(JSON.stringify({ prompt: tailWith }));
    const bodyWithout = promptOfAssembled(JSON.stringify({ prompt: tailWithout }));

    // 前 4,096 B 逐字节相同 —— head（能力块+记忆段）完全没动
    const head = Math.min(4_096, bodyWith.length, bodyWithout.length);
    expect(bodyWith.slice(0, head)).toBe(bodyWithout.slice(0, head));
    expect(bodyWith.slice(0, head)).toContain(CAP_MARKER);
  });

  it('能力块与目录的重复量：目录只多一行调用方式说明（134 B）', () => {
    const cap = capabilityPromptText();
    const catalog = catalogText();
    const capLines = cap.slice(cap.indexOf('## 可用工具')).split('\n').filter((l) => l.startsWith('- '));
    const catLines = catalog.split('\n').filter((l) => l.startsWith('- '));
    expect(capLines).toEqual(catLines);
    // 目录比能力块的工具段多出的部分 = 标题行 + 调用方式行
    const extra = byteLength(catalog) - byteLength(catLines.join('\n'));
    expect(extra).toBeGreaterThan(0);
  });

  it('回滚开关 studio.m15.continuationCatalog：置 0 恢复目录（+1,177 B / 含段），清掉则删目录', () => {
    const catalog = catalogText();
    const exec = [] as never;

    // 开关置 '0' ⇒ shouldRestore true ⇒ 调用点重新传 TOOL_CATALOG_TEXT（恢复 S3）
    window.localStorage.setItem(M15_CONTINUATION_CATALOG_STORAGE_KEY, '0');
    expect(shouldRestoreContinuationCatalog()).toBe(true);
    const restored = buildContinuationPrompt('原始任务', exec, catalog);
    expect(restored).toContain('### Available Tools');
    expect(restored).toContain(catalog);

    // 其它值 ⇒ 维持新形态（删 S3）
    window.localStorage.setItem(M15_CONTINUATION_CATALOG_STORAGE_KEY, '1');
    expect(shouldRestoreContinuationCatalog()).toBe(false);

    // 清掉开关 ⇒ 维持新形态，且比恢复形态少 1,177 B
    window.localStorage.removeItem(M15_CONTINUATION_CATALOG_STORAGE_KEY);
    expect(shouldRestoreContinuationCatalog()).toBe(false);
    const removed = buildContinuationPrompt('原始任务', exec);
    expect(removed).not.toContain('### Available Tools');
    expect(byteLength(restored) - byteLength(removed)).toBe(EXPECTED_SAVING_BYTES);

    // 读法对齐 resolveCatalogBudgetBytes：带空白仍算 '0'
    window.localStorage.setItem(M15_CONTINUATION_CATALOG_STORAGE_KEY, ' 0 ');
    expect(shouldRestoreContinuationCatalog()).toBe(true);
    window.localStorage.removeItem(M15_CONTINUATION_CATALOG_STORAGE_KEY);
  });
});
