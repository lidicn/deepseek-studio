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
import { scanSkills, ensureSkillsDir, resolveSkillsDir } from '../../src/host/skill-store';
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
    expect(mapped3?.params.tags).toEqual([]);
  });
});
