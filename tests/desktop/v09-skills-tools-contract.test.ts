/**
 * v0.9 验收测试：本地技能 + 工具目录 + 本机执行语义对齐
 *
 * 验收标准（来自路线图 v0.9）：
 * - 本地技能扫描（skill.list）：扫描技能目录，返回可用技能列表
 * - 工具目录（tool-definitions）：所有工具在注册表中可见，风险等级正确
 * - 本机执行语义对齐：shell_exec / local_file_read / local_file_write / local_file_stat 的参数映射正确
 * - 技能对可信目录内文件的访问自动放行
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanSkills, ensureSkillsDir, resolveSkillsDir, resolveSkillRoots, readConfiguredSkillsDir, persistSkillsDir } from '../../src/host/skill-store';
import { persistConfigPatch } from '../../src/host/workspace';
import { DEFAULT_TOOL_DEFINITIONS, DEEPSEEK_ORIGIN } from '../../src/host/tool-definitions';
import {
  mapUpstreamToolInvocation,
  isSupportedUpstreamTool,
  SUPPORTED_INVOCATION_NAMES,
} from '../../src/shared/tool-contract';

const tmpDir = path.join(os.tmpdir(), `studio-v09-test-${Date.now()}`);

beforeEach(async () => {
  await fs.promises.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('v0.9: 本地技能系统（skill-store）', () => {
  it('scanSkills 返回空列表当目录不存在', () => {
    const skills = scanSkills(path.join(tmpDir, 'nonexistent'));
    expect(skills).toEqual([]);
  });

  it('scanSkills 扫描包含 SKILL.md 的子目录', () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '# 我的技能\n\n这是一个测试技能。',
      'utf8',
    );

    const skills = scanSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('my-skill');
    expect(skills[0].name).toBe('我的技能');
    expect(skills[0].description).toContain('测试技能');
    expect(skills[0].skillMdPath).toBe(path.join(skillDir, 'SKILL.md'));
  });

  it('scanSkills 跳过不含 SKILL.md 的子目录', () => {
    const emptyDir = path.join(tmpDir, 'empty-skill');
    fs.mkdirSync(emptyDir, { recursive: true });

    const skills = scanSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('resolveSkillsDir 优先级：显式 > 环境变量 > 默认', () => {
    expect(resolveSkillsDir('/tmp/explicit')).toBe('/tmp/explicit');
    const prev = process.env.STUDIO_SKILLS_DIR;
    try {
      process.env.STUDIO_SKILLS_DIR = '/tmp/env-skills';
      expect(resolveSkillsDir()).toBe('/tmp/env-skills');
      expect(resolveSkillsDir('/tmp/explicit2')).toBe('/tmp/explicit2');
    } finally {
      if (prev === undefined) delete process.env.STUDIO_SKILLS_DIR;
      else process.env.STUDIO_SKILLS_DIR = prev;
    }
  });

  it('2026-11-11 回归：设置面板「扫描」必须落盘——持久化的 skillsDir 压过默认链', () => {
    // 根因：面板过去只把路径当**单次调用参数**（`skill.list {dir}`），从不写 config.json。
    // 于是 `/` 弹层与 interceptor 传 `{}` 走默认链（`<config>/skills`，不存在）⇒ 弹层恒空；
    // 重开面板输入框又被 `data.dir` 反向覆盖回默认值 ⇒ 用户观感「指定了路径却没跟着改」。
    const prevConfig = process.env.STUDIO_CONFIG_DIR;
    try {
      process.env.STUDIO_CONFIG_DIR = tmpDir;
      const home = path.join(tmpDir, 'home');
      fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
      const custom = path.join(tmpDir, 'custom-skills');
      fs.mkdirSync(custom, { recursive: true });

      // 未配置 → 默认集合（多根，第一个是 ~/.agents/skills）
      expect(persistSkillsDir('').ok).toBe(true);
      expect(readConfiguredSkillsDir()).toBeNull();
      expect(resolveSkillsDir(undefined, home)).toBe(path.join(home, '.agents', 'skills'));

      // 保存后 → 配置**压过整个默认集合**（只返回它一枚；`skill.list {}` 也走它，弹层才有内容）
      expect(persistSkillsDir(custom).ok).toBe(true);
      expect(readConfiguredSkillsDir()).toBe(custom);
      expect(resolveSkillsDir(undefined, home)).toBe(custom);
      expect(resolveSkillRoots(undefined, home)).toEqual([custom]);

      // 清空输入框再扫描＝清除配置，回落默认集合
      expect(persistSkillsDir('').ok).toBe(true);
      expect(readConfiguredSkillsDir()).toBeNull();
      expect(resolveSkillsDir(undefined, home)).toBe(path.join(home, '.agents', 'skills'));
    } finally {
      if (prevConfig === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = prevConfig;
    }
  });

  // 0.14.20 收口：清空必须**删键**，不是留一个 `skillsDir: ""` 的空键。
  // 旧锁只断 `readConfiguredSkillsDir() === null`（空串也满足），抓不到"键还在"。
  it('清空技能目录＝从 config.json 里删除 skillsDir 键（不是留空串）', () => {
    const prevConfig = process.env.STUDIO_CONFIG_DIR;
    try {
      process.env.STUDIO_CONFIG_DIR = tmpDir;
      const configPath = path.join(tmpDir, 'config.json');
      const custom = path.join(tmpDir, 'custom-skills');
      fs.mkdirSync(custom, { recursive: true });

      expect(persistSkillsDir(custom).ok).toBe(true);
      const afterSet = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(afterSet.skillsDir).toBe(custom);

      // 先落一个**已知**的无关键，才能证"删键只针对被清空的那个键，不是整份覆盖"。
      // （旧版这里写 `expect(Object.keys(afterClear).length).toBeGreaterThanOrEqual(0)`，
      //  对任何对象恒真、零判别力，等于这条语义没锁。）
      expect(persistConfigPatch({ policyMode: 'full' }).ok).toBe(true);
      const afterPatch = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(afterPatch.policyMode).toBe('full');
      expect(afterPatch.skillsDir).toBe(custom); // 打补丁不清掉别的键

      expect(persistSkillsDir('').ok).toBe(true);
      const afterClear = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      // 负控：改成写空串（`{ skillsDir: '' }`）⇒ 本断言必红
      expect(Object.prototype.hasOwnProperty.call(afterClear, 'skillsDir')).toBe(false);
      // 未知键必须原样保留（删键只针对被清空的那个键，不是整份覆盖）
      // 负控：把删键改成 `bag = { ...patch }` 整份覆盖 ⇒ 本断言必红（policyMode 丢失）
      expect(afterClear.policyMode).toBe('full');
    } finally {
      if (prevConfig === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = prevConfig;
    }
  });

  // 0.14.20（出资人拍板「两个都要」）：默认集合是**两枚**，不是首匹配即返回的单值链。
  it('默认技能集合＝两枚根：~/.agents/skills 与 <configDir>/skills（存在与否都列）', () => {
    const prevConfig = process.env.STUDIO_CONFIG_DIR;
    try {
      process.env.STUDIO_CONFIG_DIR = tmpDir;
      const home = path.join(tmpDir, 'home-two-roots');
      fs.mkdirSync(home, { recursive: true });
      const roots = resolveSkillRoots(undefined, home);
      expect(roots).toHaveLength(2);
      // 负控：删掉第一根 ⇒ 这两条必红（旧单值链就是"有第一根就没第二根"）
      expect(roots[0]).toBe(path.join(home, '.agents', 'skills'));
      expect(roots[1]).toBe(path.join(tmpDir, 'skills'));
      // 两个目录都**不存在**时也照样列出（面板要显示路径告诉用户往哪放）
      expect(fs.existsSync(roots[0])).toBe(false);
      expect(fs.existsSync(roots[1])).toBe(false);
      // 单一取值入口＝第一根（向后兼容）
      expect(resolveSkillsDir(undefined, home)).toBe(roots[0]);
    } finally {
      if (prevConfig === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = prevConfig;
    }
  });

  it('scanSkills 多根合并：同一个 id（目录名）先到先得（roots 顺序＝优先级）', () => {
    const rootA = path.join(tmpDir, 'rootA');
    const rootB = path.join(tmpDir, 'rootB');
    for (const [root, body] of [[rootA, 'A 版'], [rootB, 'B 版']] as const) {
      fs.mkdirSync(path.join(root, 'dup-skill'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dup-skill', 'SKILL.md'), `---\nname: ${body}\n---\n正文\n`, 'utf8');
      fs.mkdirSync(path.join(root, `only-${path.basename(root)}`), { recursive: true });
      fs.writeFileSync(path.join(root, `only-${path.basename(root)}`, 'SKILL.md'), `# ${root}\n`, 'utf8');
    }
    const merged = scanSkills([rootA, rootB]);
    const dup = merged.filter((s) => s.id === 'dup-skill');
    expect(dup).toHaveLength(1); // 同名只出现一次
    expect(dup[0].name).toBe('A 版'); // 第一根先到先得
    expect(merged.map((s) => s.id).sort()).toEqual(['dup-skill', 'only-rootA', 'only-rootB']);
    // 负控：只给第二根 ⇒ 拿到的就是 B 版（证明"先到先得"不是随便取的）
    expect(scanSkills([rootB]).find((s) => s.id === 'dup-skill')?.name).toBe('B 版');
  });

  it('ensureSkillsDir 创建空目录，不写入示例技能', () => {
    const dir = path.join(tmpDir, 'fresh-skills');
    const returned = ensureSkillsDir(dir);
    expect(returned).toBe(dir);
    expect(fs.existsSync(dir)).toBe(true);
    // 目录应为空（旧实现会塞入 example-skill，属"假技能"）
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(scanSkills(dir)).toEqual([]);
  });

  it('scanSkills 按名称排序', () => {
    for (const name of ['zebra', 'apple', 'mango']) {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n\ndesc`, 'utf8');
    }

    const skills = scanSkills(tmpDir);
    expect(skills.map((s) => s.id)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('scanSkills 从 frontmatter 提取 name 和 description', () => {
    const skillDir = path.join(tmpDir, 'fm-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: 自定义名称
description: 自定义描述
---
# 标题不会覆盖

正文。`,
      'utf8',
    );

    const skills = scanSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('自定义名称');
    expect(skills[0].description).toBe('自定义描述');
  });

  it('scanSkills 从一级标题提取名称，从第一段提取描述', () => {
    const skillDir = path.join(tmpDir, 'title-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `# 技能标题

这是第一段描述文字。

## 子标题

更多内容。`,
      'utf8',
    );

    const skills = scanSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('技能标题');
    expect(skills[0].description).toContain('第一段描述');
  });

});

describe('v0.9: 工具目录（tool-definitions）', () => {
  it('所有工具定义都有 id/title/description/risk/allowedOrigins', () => {
    for (const tool of DEFAULT_TOOL_DEFINITIONS) {
      expect(tool.id).toBeTruthy();
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(['read', 'insert', 'send', 'privileged']).toContain(tool.risk);
      expect(tool.allowedOrigins).toContain(DEEPSEEK_ORIGIN);
    }
  });

  it('v0.5 宿主侧能力标记 execution: host', () => {
    const hostTools = DEFAULT_TOOL_DEFINITIONS.filter((t) => t.execution === 'host');
    const hostToolIds = hostTools.map((t) => t.id);
    expect(hostToolIds).toContain('shell.exec');
    expect(hostToolIds).toContain('file.read');
    expect(hostToolIds).toContain('file.write');
    expect(hostToolIds).toContain('file.list');
    expect(hostToolIds).toContain('file.stat');
  });

  it('v0.9 技能工具在目录中', () => {
    const skillTool = DEFAULT_TOOL_DEFINITIONS.find((t) => t.id === 'skill.list');
    expect(skillTool).toBeDefined();
    expect(skillTool?.risk).toBe('read');
    expect(skillTool?.execution).toBe('host');
  });

  it('v1.0 移植工具在目录中（memory.save / python.exec / mcp.list / mcp.call）', () => {
    const ids = DEFAULT_TOOL_DEFINITIONS.map((t) => t.id);
    expect(ids).toContain('memory.save');
    expect(ids).toContain('python.exec');
    expect(ids).toContain('mcp.list');
    expect(ids).toContain('mcp.call');
  });

  it('工具 id 唯一', () => {
    const ids = DEFAULT_TOOL_DEFINITIONS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('v0.9: 本机执行语义对齐（tool-contract 映射）', () => {
  it('shell_exec → shell.exec，command 参数正确映射', () => {
    const mapped = mapUpstreamToolInvocation('shell_exec', { command: 'dir C:\\' });
    expect(mapped).not.toBeNull();
    expect(mapped?.id).toBe('shell.exec');
    expect(mapped?.params.command).toBe('dir C:\\');
  });

  it('shell_exec 支持 cmd 别名和 timeout_ms/cwd', () => {
    const mapped = mapUpstreamToolInvocation('shell_exec', {
      cmd: 'ls',
      timeout_ms: 5000,
      cwd: '/tmp',
    });
    expect(mapped?.params.command).toBe('ls');
    expect(mapped?.params.timeoutMs).toBe(5000);
    expect(mapped?.params.cwd).toBe('/tmp');
  });

  it('local_file_read → file.read，path/start/max_chars 映射', () => {
    const mapped = mapUpstreamToolInvocation('local_file_read', {
      path: '/etc/hosts',
      start: 10,
      max_chars: 1000,
    });
    expect(mapped?.id).toBe('file.read');
    expect(mapped?.params.path).toBe('/etc/hosts');
    expect(mapped?.params.offset).toBe(10);
    expect(mapped?.params.limit).toBe(1000);
  });

  it('local_file_write → file.write，path/content 映射', () => {
    const mapped = mapUpstreamToolInvocation('local_file_write', {
      path: '/tmp/test.txt',
      content: 'hello',
    });
    expect(mapped?.id).toBe('file.write');
    expect(mapped?.params.path).toBe('/tmp/test.txt');
    expect(mapped?.params.content).toBe('hello');
  });

  it('local_file_stat → file.stat', () => {
    const mapped = mapUpstreamToolInvocation('local_file_stat', { path: '/tmp' });
    expect(mapped?.id).toBe('file.stat');
    expect(mapped?.params.path).toBe('/tmp');
  });

  it('memory_save → memory.save，type/name/content/tags 映射', () => {
    const mapped = mapUpstreamToolInvocation('memory_save', {
      type: 'project',
      name: '架构决策',
      content: '使用 Tauri',
      tags: ['架构', 'Tauri'],
    });
    expect(mapped?.id).toBe('memory.save');
    expect(mapped?.params.type).toBe('project');
    expect(mapped?.params.name).toBe('架构决策');
    expect(mapped?.params.content).toBe('使用 Tauri');
    expect(mapped?.params.tags).toEqual(['架构', 'Tauri']);
  });

  it('python_exec → python.exec', () => {
    const mapped = mapUpstreamToolInvocation('python_exec', { code: 'print(1)' });
    expect(mapped?.id).toBe('python.exec');
    expect(mapped?.params.code).toBe('print(1)');
  });

  it('mcp_list → mcp.list，mcp_call → mcp.call', () => {
    const list = mapUpstreamToolInvocation('mcp_list', {});
    expect(list?.id).toBe('mcp.list');

    const call = mapUpstreamToolInvocation('mcp_call', {
      serverId: 'github',
      tool: 'create_issue',
      args: { title: 'test' },
    });
    expect(call?.id).toBe('mcp.call');
    expect(call?.params.serverId).toBe('github');
    expect(call?.params.tool).toBe('create_issue');
    expect(call?.params.args).toEqual({ title: 'test' });
  });

  it('不受支持的工具返回 null（不拦截）', () => {
    expect(mapUpstreamToolInvocation('unknown_tool', {})).toBeNull();
    expect(isSupportedUpstreamTool('unknown_tool')).toBe(false);
  });

  it('SUPPORTED_INVOCATION_NAMES 包含所有已映射工具', () => {
    expect(SUPPORTED_INVOCATION_NAMES).toContain('shell_exec');
    expect(SUPPORTED_INVOCATION_NAMES).toContain('local_file_read');
    expect(SUPPORTED_INVOCATION_NAMES).toContain('local_file_write');
    expect(SUPPORTED_INVOCATION_NAMES).toContain('local_file_stat');
    expect(SUPPORTED_INVOCATION_NAMES).toContain('memory_save');
    expect(SUPPORTED_INVOCATION_NAMES).toContain('python_exec');
    expect(SUPPORTED_INVOCATION_NAMES).toContain('mcp_list');
    expect(SUPPORTED_INVOCATION_NAMES).toContain('mcp_call');
  });

  it('参数缺失时使用默认值（fail-soft，不崩溃）', () => {
    const mapped = mapUpstreamToolInvocation('shell_exec', {});
    expect(mapped?.params.command).toBe('');

    const mapped2 = mapUpstreamToolInvocation('local_file_read', {});
    expect(mapped2?.params.path).toBe('');

    const mapped3 = mapUpstreamToolInvocation('memory_save', {});
    expect(mapped3?.params.type).toBe('user');
    // D-5：缺省字段不再被固化成 []/false，改由 store 在插入时套默认值。
    // 否则同名保存会把已有 tags/pinned 当成「显式清空」（2026-10-26 真机回归）。
    expect(mapped3?.params).not.toHaveProperty('tags');
    expect(mapped3?.params).not.toHaveProperty('pinned');
  });
});
