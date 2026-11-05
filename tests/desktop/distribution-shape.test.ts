/**
 * tests/desktop/distribution-shape.test.ts
 *
 * **批 N 口径**（Studio-PM 裁定③，2026-11-06）：本批只落地「形态判定 + 5 处认 env」，
 * **D 组（装版不写示例 / 装版不建技能目录 / 装版跳过 `~/.agents/skills`）与段 2 路径注入
 * 一并留到批 N+1**（必须与段 3 首启迁移同批，否则老用户数据会「看起来消失」）。
 *
 * 因此本文件分两部分：
 * 1. **批 N 不变量**：形态判定 fail-safe、`resolveConfigDir` 回落、**装版路径不变**、
 *    **dev 宿主（不经 Rust）拿得到 dev 形态**；
 * 2. **批 N+1 待启用项**：以 `it.skip` 形式留住口径（D 组三条），批 N+1 解开即可当回归。
 *    —— 不用「改实现让测试变绿」，也不删断言不补（群纪律第 4 条）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveStudioDistribution,
  isInstalledDistribution,
  resolveConfigDir,
} from '../../src/shared/distribution';
import { ensureMcpConfig } from '../../src/host/mcp-controller';
import { resolveSkillsDir, ensureSkillsDir } from '../../src/host/skill-store';

const ENV_KEYS = ['STUDIO_DISTRIBUTION', 'STUDIO_CONFIG_DIR', 'STUDIO_SKILLS_DIR'] as const;
const agentsDir = path.join(os.homedir(), '.agents', 'skills');

/**
 * **`beforeAll` 里**捕获 setupFiles 注入的形态。
 *
 * 为什么不在模块顶层捕获：实测 vitest 的 `setupFiles` 在测试文件模块**求值之后**才跑，
 * 顶层 `const x = process.env.STUDIO_DISTRIBUTION` 会拿到 `undefined`（PM 07:11 实跑发现）。
 * `beforeAll` 晚于 setupFiles、且早于本文件的 `beforeEach`（后者为了测 fail-safe 会删该 env）。
 */
let setupInjectedDistribution: string | undefined;

let saved: Record<string, string | undefined>;
let tmp: string;

beforeAll(() => {
  setupInjectedDistribution = process.env.STUDIO_DISTRIBUTION;
});

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dist-'));
  process.env.STUDIO_CONFIG_DIR = tmp;
  delete process.env.STUDIO_SKILLS_DIR;
  delete process.env.STUDIO_DISTRIBUTION;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('§8.3 形态判定（fail-safe = installed，判错代价不对称）', () => {
  it('缺失 / 非法值 → installed', () => {
    expect(resolveStudioDistribution({} as NodeJS.ProcessEnv)).toBe('installed');
    expect(resolveStudioDistribution({ STUDIO_DISTRIBUTION: '' } as NodeJS.ProcessEnv)).toBe('installed');
    expect(resolveStudioDistribution({ STUDIO_DISTRIBUTION: 'garbage' } as NodeJS.ProcessEnv)).toBe('installed');
    expect(resolveStudioDistribution({ STUDIO_DISTRIBUTION: 'INSTALLED' } as NodeJS.ProcessEnv)).toBe('installed');
    expect(isInstalledDistribution({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('仅显式 dev → dev（大小写/空白归一）', () => {
    expect(resolveStudioDistribution({ STUDIO_DISTRIBUTION: 'dev' } as NodeJS.ProcessEnv)).toBe('dev');
    expect(resolveStudioDistribution({ STUDIO_DISTRIBUTION: ' DEV ' } as NodeJS.ProcessEnv)).toBe('dev');
    expect(isInstalledDistribution({ STUDIO_DISTRIBUTION: 'dev' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('批 N 不变量：装版与 dev 的路径行为都不变（改前改后逐字节等价）', () => {
  it('resolveConfigDir：env 优先；缺省回落 <homedir>/.config/deepseek-studio', () => {
    expect(resolveConfigDir({ STUDIO_CONFIG_DIR: tmp } as NodeJS.ProcessEnv)).toBe(tmp);
    expect(resolveConfigDir({} as NodeJS.ProcessEnv, path.join('X:', 'home'))).toBe(
      path.join('X:', 'home', '.config', 'deepseek-studio'),
    );
    // 空白 env 视为未设
    expect(
      resolveConfigDir({ STUDIO_CONFIG_DIR: '   ' } as NodeJS.ProcessEnv, path.join('X:', 'home')),
    ).toBe(path.join('X:', 'home', '.config', 'deepseek-studio'));
  });

  it('D 组未启用：装版形态下 ensureMcpConfig 仍写示例（批 N+1 才反转）', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const p = ensureMcpConfig();
    expect(p).toBe(path.join(tmp, 'mcp-servers.json'));
    expect(fs.existsSync(p)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { servers: Record<string, unknown> };
    expect(Object.keys(parsed.servers)).toContain('example-filesystem');
  });

  it('D 组未启用：装版形态下第 ③ 位仍无条件命中 ~/.agents/skills', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const resolved = resolveSkillsDir();
    if (fs.existsSync(agentsDir)) {
      expect(resolved).toBe(agentsDir);
    } else {
      // 干净机没有 ~/.agents/skills → 回落 <config>/skills（与改前一致）
      expect(resolved).toBe(path.join(tmp, 'skills'));
    }
  });

  it('显式传入 skillsDir 仍按原语义创建（面板「添加技能目录」不受形态影响）', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const explicit = path.join(tmp, 'my-skills');
    expect(ensureSkillsDir(explicit)).toBe(explicit);
    expect(fs.existsSync(explicit)).toBe(true);
  });
});

describe('裁定② 回归：不经 Rust 启动的 dev 宿主必须拿到 dev 形态', () => {
  it('测试脚手架（setupFiles）在 env 未设时注入 STUDIO_DISTRIBUTION=dev', () => {
    // 读 `beforeAll` 捕获的值（见文件头注释）：不能用当前 process.env ——
    // beforeEach 为了测 fail-safe 已经把它删了。若有人去掉 setupFiles 的注入，本条会红。
    expect(setupInjectedDistribution).toBe('dev');
  });

  it('dev 宿主：resolveSkillsDir 命中 ~/.agents/skills（若存在），且 ensureMcpConfig 写 dev 示例', () => {
    // 显式声明 dev（与 dev-main.ts 的语义一致：由启动方声明，Node 不自己猜）
    process.env.STUDIO_DISTRIBUTION = 'dev';

    if (fs.existsSync(agentsDir)) {
      expect(resolveSkillsDir()).toBe(agentsDir);
    }

    const p = ensureMcpConfig();
    expect(fs.existsSync(p)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { servers: Record<string, unknown> };
    expect(Object.keys(parsed.servers)).toContain('example-filesystem');
  });
});

describe('批 N+1 待启用（D 组）：解开 skip 即可当回归用', () => {
  it.skip('installed → ensureMcpConfig 不创建文件（且不得含 example-filesystem）', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const p = ensureMcpConfig();
    expect(fs.existsSync(p)).toBe(false);
  });

  it.skip('installed → resolveSkillsDir 返回 <STUDIO_CONFIG_DIR>/skills，且不命中 ~/.agents/skills', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    expect(resolveSkillsDir()).toBe(path.join(tmp, 'skills'));
    expect(resolveSkillsDir()).not.toBe(agentsDir);
  });

  it.skip('installed → ensureSkillsDir 直接 return，不创建 <config>/skills', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    expect(ensureSkillsDir()).toBe(path.join(tmp, 'skills'));
    expect(fs.existsSync(path.join(tmp, 'skills'))).toBe(false);
  });
});
