/**
 * tests/desktop/distribution-shape.test.ts
 *
 * **批 N+1 口径**（2026-11-06）：D 组（装版不写示例 / 装版不建技能目录）与段 2 路径注入、
 * 段 3 首启迁移**同批落地**（PM 裁定③）。批 N 期间以 `it.skip` 留住的 3 条口径
 * **已解开并全部执行**（不许永久留在跳过态）。
 *
 * **2026-11-11 口径反转（用户拍板）**：原批 N+1 第③条「装版跳过 `~/.agents/skills`」**作废**。
 * 依据 Agent Skills 官方实施指南（agentskills.io/client-implementation/adding-skills-support）：
 * `.agents/skills/` 是「跨客户端共享技能的广泛采纳约定」，官方要求 User scope 扫
 * `~/.agents/skills/`；规范只定义 `SKILL.md` 内容、不规定目录位置，**不扫**就等于看不到别的
 * 合规客户端装的技能。原顾虑（装版误命中＝污染用户机）不成立：只 `existsSync` 只读判断，
 * 创建与否由 `ensureSkillsDir` 单独管（装版仍不创建）。
 *
 * 本文件覆盖：
 * 1. 形态判定 fail-safe（缺失/非法 → installed）、`resolveConfigDir` 回落；
 * 2. dev 与装版两形态下的 D 组行为（**双向**：装版不写示例 / dev 仍写示例）；
 * 3. 「不经 Rust 启动的 dev 宿主必须拿到 dev 形态」这条裁定②回归。
 *
 * 批 N 曾有两条「D 组未启用」的反向断言（断言装版仍写示例、仍命中 ③ 位）——
 * 那是锁「批 N 零行为变化」的**过时断言**，本批按群纪律第 4 条换成
 * 「装版不写示例 / 不命中 ③ 位」的真回归断言，不是只删不补。
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

  it('批 N+1 反转：装版形态下 ensureMcpConfig 不写示例（D 组已落地）', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const p = ensureMcpConfig();
    expect(p).toBe(path.join(tmp, 'mcp-servers.json'));
    // 装版：不创建、不写 example-filesystem
    expect(fs.existsSync(p)).toBe(false);
  });

  it('2026-11-11 口径反转：装版形态下 `~/.agents/skills` 存在即命中（跨客户端互操作）', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    expect(resolveSkillsDir(undefined, home)).toBe(path.join(home, '.agents', 'skills'));
    // 负控：该目录不存在时不得凭空指过去，必须回落 <config>/skills
    const homeEmpty = path.join(tmp, 'home-empty');
    fs.mkdirSync(homeEmpty, { recursive: true });
    expect(resolveSkillsDir(undefined, homeEmpty)).toBe(path.join(tmp, 'skills'));
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

describe('批 N+1（D 组）：解跳后的回归断言（批 N 时以 it.skip 留口径）', () => {
  it('installed → ensureMcpConfig 不创建文件（且不得含 example-filesystem）', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const p = ensureMcpConfig();
    expect(fs.existsSync(p)).toBe(false);
  });

  it('installed → 无任何配置时 resolveSkillsDir 返回 <STUDIO_CONFIG_DIR>/skills（负控：不凭猜）', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const home = path.join(tmp, 'home-plain');
    fs.mkdirSync(home, { recursive: true });
    expect(resolveSkillsDir(undefined, home)).toBe(path.join(tmp, 'skills'));
    expect(resolveSkillsDir(undefined, home)).not.toBe(agentsDir);
  });

  it('installed → ensureSkillsDir 直接 return，不创建 <config>/skills', () => {
    process.env.STUDIO_DISTRIBUTION = 'installed';
    const home = path.join(tmp, 'home-plain2');
    fs.mkdirSync(home, { recursive: true });
    expect(ensureSkillsDir(undefined, home)).toBe(path.join(tmp, 'skills'));
    expect(fs.existsSync(path.join(tmp, 'skills'))).toBe(false);
  });
});
