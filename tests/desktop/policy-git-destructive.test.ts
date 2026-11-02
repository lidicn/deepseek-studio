/**
 * C1 墨鉴 R15 回归测试：Git 破坏性命令守卫 + python.exec 风险检测。
 *
 * 契约（对应 R15-001 / R15-002）：
 *   1. **git-destructive 覆盖 clean 的任意 force 组合** —— `git clean -xfd` / `-fdx` / `-df`
 *      / `--force` 等**全部必须命中**；原正则只匹配 `-fd`，`-xfd` 直接逃检。
 *      同时覆盖 `checkout .` / `restore .` / `reset --hard` / `push --force`。
 *   2. **python.exec 在 auto 档要经过风险检测** —— 它不在 PROCESS_TOOLS 里，
 *      原实现从不调 detectRisks → auto 档下破坏性 Python 代码不会被识别为风险、
 *      也就不会触发同意闸门。
 */
import { describe, it, expect } from 'vitest';
import { detectRisks, evaluatePolicy, type PolicyInput } from '../../src/host/policy';

const wsStub = {
  root: 'C:/proj',
  contains: () => true,
} as unknown as PolicyInput['workspace'];

function verdict(tool: string, params: Record<string, unknown>, mode: PolicyInput['mode']) {
  return evaluatePolicy({ tool, params, mode, workspace: wsStub });
}

describe('C1 R15-001：git 破坏性命令守卫（表驱动）', () => {
  // 每条变体都必须命中 git-destructive。
  const MUST_HIT = [
    'git clean -fd',
    'git clean -xfd', // ← 原实现逃检（不匹配 -fd）
    'git clean -fdx', // ← 原实现逃检
    'git clean -df', // ← 原实现逃检
    'git clean -xffd', // ← 原实现逃检
    'git clean --force', // ← 原实现逃检
    'git clean -f -d',
    'git clean -d -f',
    'git checkout -- .',
    'git checkout .',
    'git restore .',
    'git restore -- .',
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git push --force',
    'git push -f origin main',
  ];

  it.each(MUST_HIT)('命中：%s', (cmd) => {
    expect(detectRisks(cmd)).toContain('git-destructive');
  });

  // 不该误伤的普通 git 命令。
  const MUST_NOT_HIT = [
    'git status',
    'git log --oneline -10',
    'git diff',
    'git add .',
    'git commit -m "fix: something"',
    'git clean -n', // dry-run，不删东西
    'git checkout feature-branch',
    'git restore --source=HEAD file.ts',
    'git push origin main',
    'git reset --soft HEAD~1',
  ];

  it.each(MUST_NOT_HIT)('不误伤：%s', (cmd) => {
    expect(detectRisks(cmd)).not.toContain('git-destructive');
  });
});

describe('C1 R15-002：python.exec 在 auto 档的风险检测', () => {
  it('auto 档：破坏性 Python 代码必须触发同意闸门', () => {
    const v = verdict(
      'python.exec',
      { code: 'import shutil; shutil.rmtree("C:/important")' },
      'auto',
    );
    expect(v.decision).toBe('require-consent');
    expect(v.reason).toBe('risk-detected');
    expect(v.riskFlags).toContain('python-destructive');
  });

  it('auto 档：普通 Python 代码不触发闸门', () => {
    const v = verdict('python.exec', { code: 'print(sum(range(10)))' }, 'auto');
    expect(v.decision).toBe('allow');
  });

  it('ask 档：破坏性 Python 代码触发同意闸门', () => {
    const v = verdict(
      'python.exec',
      { code: 'import os; os.remove("C:/x.txt")' },
      'ask',
    );
    expect(v.decision).toBe('require-consent');
    expect(v.reason).toBe('risk-detected');
  });

  it('workspace 档：python.exec 仍然硬拒绝（不变）', () => {
    const v = verdict('python.exec', { code: 'print(1)' }, 'workspace');
    expect(v.decision).toBe('deny');
    expect(v.reason).toBe('mode-restricted');
  });

  it('full 档：放行但如实记录 riskFlags（可审计）', () => {
    const v = verdict(
      'python.exec',
      { code: 'import shutil; shutil.rmtree("C:/x")' },
      'full',
    );
    expect(v.decision).toBe('allow');
    expect(v.riskFlags).toContain('python-destructive');
  });
});

