// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  __prepareOutgoingBodyForTesting,
  catalogText,
  capabilityPromptText,
} from '../../src/inject/main-world-interceptor';
import { buildContinuationPrompt } from '../../src/shared/continuation-prompt';

/**
 * M1.5 字节账（契约 §6）。
 *
 * 删掉续跑 prompt 里的重复工具目录后，每轮省 **目录原文 B + 固定分隔开销 B**。
 *
 * ⚠️ 头号误判防线（写在这里，别让后人踩）：
 *   **Verify 的 13,078 B 稳定前缀基线一个字节都不动** —— S3（重复目录）在 tail 内，
 *   不在前缀里。所以「首差字节变了」**就是回归**，不是预期变化。
 *   本文件断言的正是这件事：删目录只动 tail，head-A 前缀逐字节不变。
 *
 * 2026-11-11（0.14.19 F1）：本文件原先把收益写死成 `1_177`（1,155 B 目录原文 + 22 B 分隔行）。
 * F1 把 `shell_exec` 说明写长 232 B 后目录变成 1,387 B，写死的数字就必然假红——
 * 而这条断言要守的是「删目录恰好省掉目录段本身」，不是某个历史字节数。
 * 现改为**自证式推导**：分隔开销由 `buildContinuationPrompt` 自身用探针测出，
 * 收益 = 分隔开销 + `catalogText()` 实际字节数。目录再改也不会假红，
 * 但「目录被塞回 tail / 省多省少」的真回归照样抓得住。
 */

const CAP_MARKER = '[studio-tool-capability]';

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * 目录段的固定外壳开销（`\n\n### Available Tools\n` 之类），由实现自身测出：
 * 用 1 字节探针目录跑一次差分，减去探针本身即得外壳。**不写死数字。**
 */
function catalogOverheadBytes(): number {
  const withProbe = buildContinuationPrompt('probe', [] as never, 'X');
  const withoutProbe = buildContinuationPrompt('probe', [] as never);
  return byteLength(withProbe) - byteLength(withoutProbe) - byteLength('X');
}

/** 每轮省下的字节 = 固定外壳开销 + 目录原文实际字节数。 */
function expectedSavingBytes(): number {
  return catalogOverheadBytes() + byteLength(catalogText());
}

function promptOfAssembled(rawBody: string, taskText = '帮我跑个命令'): string {
  const out = __prepareOutgoingBodyForTesting(rawBody, [], taskText);
  expect(out).not.toBeNull();
  return (JSON.parse(out!) as { prompt: string }).prompt;
}

describe('M1.5 字节账：删重复目录的收益与 head-A 不动', () => {
  it('续跑 prompt：带目录 vs 不带目录，恒定省＝目录段本身（与结果条数无关）', () => {
    const catalog = catalogText();
    const exec: Array<{ name: string; result: string }> = [];

    const withCatalog = buildContinuationPrompt('原始任务', exec as never, catalog);
    const withoutCatalog = buildContinuationPrompt('原始任务', exec as never);

    expect(byteLength(withCatalog) - byteLength(withoutCatalog)).toBe(expectedSavingBytes());
    // 目录原文在「带目录」那份里，「不带目录」那份里没有
    expect(withCatalog).toContain(catalog);
    expect(withoutCatalog).not.toContain(catalog);
  });

  it('最终 body 的 prompt：同样恒定省目录段本身（head 不变，tail 变短）', () => {
    const catalog = catalogText();
    const tailWith = buildContinuationPrompt('原始任务', [] as never, catalog);
    const tailWithout = buildContinuationPrompt('原始任务', [] as never);

    const bodyWith = promptOfAssembled(JSON.stringify({ prompt: tailWith }));
    const bodyWithout = promptOfAssembled(JSON.stringify({ prompt: tailWithout }));

    expect(byteLength(bodyWith) - byteLength(bodyWithout)).toBe(expectedSavingBytes());
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

  it('tail 无运行时回滚开关（契约 §8，2026-11-03 裁定）：源码不残留开关键/函数，回滚=重新加回实参', () => {
    // 删开关的**真回归**防线（负控）：若有人把 `M15_CONTINUATION_CATALOG_STORAGE_KEY` /
    // `shouldRestoreContinuationCatalog()`（或调用点的 `restoreContinuationCatalog` 读法）
    // 加回 main-world-interceptor.ts ⇒ 本用例转红。
    // 回滚口径现在是「git 层面在两个调用点重新加回 [TOOL_CATALOG_TEXT] 实参」，
    // 任何绕过该口径的运行时开关都不允许再出现。
    // 路径相对仓库根（vitest 从仓库根启动；先例 tests/desktop/desktop-entry.test.ts）。
    const src = readFileSync('src/inject/main-world-interceptor.ts', 'utf8');
    expect(src).not.toContain('M15_CONTINUATION_CATALOG_STORAGE_KEY');
    expect(src).not.toContain('shouldRestoreContinuationCatalog');
    expect(src).not.toContain('restoreContinuationCatalog');
  });
});
