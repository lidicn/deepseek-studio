/**
 * S4 边界审计测试：四条依赖方向规则。
 * 含反例（构造违规字符串断言被抓出）和正例（真实文件扫描）。
 */

import { describe, it, expect } from 'vitest';
import { checkFile } from '../../tools/audit/boundary';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

// ---- 反例：构造违规文件字符串 ----

describe('边界审计 · 反例断言（违规必须被抓出）', () => {
  it('1. R1: kernel import web-engine → 被抓出', () => {
    const fakeFile = join(root, 'src/host/kernel/fake.ts');
    const violations = checkFile(
      fakeFile,
      "import { createWebEngine } from '../engine/web-engine';",
      root,
    );
    expect(violations.some((v) => v.rule === 'R1')).toBe(true);
  });

  it('2. R2: engine import kernel → 被抓出', () => {
    const fakeFile = join(root, 'src/host/engine/fake.ts');
    const violations = checkFile(
      fakeFile,
      "import { createMessageHistory } from '../kernel/message-history';",
      root,
    );
    expect(violations.some((v) => v.rule === 'R2')).toBe(true);
  });

  it('3. R3: shared import host → 被抓出', () => {
    const fakeFile = join(root, 'src/shared/fake.ts');
    const violations = checkFile(
      fakeFile,
      "import { createAgentLoop } from '../host/agent-loop';",
      root,
    );
    expect(violations.some((v) => v.rule === 'R3')).toBe(true);
  });

  it('4. R4: tools import host → 被抓出', () => {
    const fakeFile = join(root, 'tools/fake.ts');
    const violations = checkFile(
      fakeFile,
      "import { createAgentLoop } from '../src/host/agent-loop';",
      root,
    );
    expect(violations.some((v) => v.rule === 'R4')).toBe(true);
  });

  it('5. R1 正例：kernel import model-engine type → 不违规', () => {
    const fakeFile = join(root, 'src/host/kernel/fake.ts');
    const violations = checkFile(
      fakeFile,
      "import type { ModelEngine } from '../engine/model-engine';",
      root,
    );
    expect(violations.some((v) => v.rule === 'R1')).toBe(false);
  });

  it('6. 合法 import（shared 内部引用 shared）→ 不违规', () => {
    const fakeFile = join(root, 'src/shared/fake.ts');
    const violations = checkFile(
      fakeFile,
      "import { something } from './other-shared';",
      root,
    );
    expect(violations.length).toBe(0);
  });

  it('7. 多条 import 混合 → 只抓违规的那条', () => {
    const fakeFile = join(root, 'src/shared/fake.ts');
    const violations = checkFile(
      fakeFile,
      "import { a } from './other-shared';\nimport { b } from '../host/agent-loop';\nimport { c } from './another-shared';",
      root,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('R3');
  });

  it('8. npm 包 import → 不违规（跳过）', () => {
    const fakeFile = join(root, 'tools/fake.ts');
    const violations = checkFile(
      fakeFile,
      "import { readFileSync } from 'node:fs';\nimport express from 'express';",
      root,
    );
    expect(violations.length).toBe(0);
  });
});
