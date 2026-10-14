/**
 * Bot 基础设施 · PersonaRegistry 验收测试（副开发 CodeBuddy）
 *
 * 契约：src/host/bot/types.ts（PersonaRegistry.load/list）。
 * 完成标志（分工方案 §2.2）：load("audit-expert") 返回完整人设包。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FilePersonaRegistry, defaultPersonasRoot } from '../../src/host/bot/persona-registry';

const tmpRoot = path.join(os.tmpdir(), `studio-persona-test-${Date.now()}`);

function writePersona(name: string, files: Record<string, string>): void {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('PersonaRegistry（FilePersonaRegistry）', () => {
  it('load 返回完整人设包（prompt + tools + memoryDir）', async () => {
    writePersona('audit-expert', {
      'prompt.md': '你是审计专家',
      'tools.json': JSON.stringify({ tools: ['file.read', 'shell.exec'] }),
      'memory/index.md': '# 根记忆',
    });
    const reg = new FilePersonaRegistry(tmpRoot);
    const p = await reg.load('audit-expert');
    expect(p.name).toBe('audit-expert');
    expect(p.prompt).toBe('你是审计专家');
    expect(p.tools).toEqual(['file.read', 'shell.exec']);
    expect(p.memoryDir).toBe(path.join(tmpRoot, 'audit-expert', 'memory'));
    expect(fs.existsSync(p.memoryDir)).toBe(true);
  });

  it('load 不存在的人设抛错（契约语义）', async () => {
    const reg = new FilePersonaRegistry(tmpRoot);
    await expect(reg.load('nope')).rejects.toThrow(/persona not found/);
  });

  it('拒绝路径穿越的人设名', async () => {
    writePersona('audit-expert', { 'prompt.md': 'x' });
    const reg = new FilePersonaRegistry(tmpRoot);
    await expect(reg.load('../audit-expert')).rejects.toThrow(/invalid persona name/);
    await expect(reg.load('a/b')).rejects.toThrow(/invalid persona name/);
  });

  it('tools.json 缺省 → 空数组（继承全部工具）', async () => {
    writePersona('dev-expert', { 'prompt.md': '你是开发专家' });
    const reg = new FilePersonaRegistry(tmpRoot);
    const p = await reg.load('dev-expert');
    expect(p.tools).toEqual([]);
  });

  it('tools.json 非法（非 JSON / 结构错）抛错且信息明确', async () => {
    writePersona('bad-json', { 'prompt.md': 'x', 'tools.json': '{not json' });
    writePersona('bad-shape', { 'prompt.md': 'x', 'tools.json': '{"tools": "file.read"}' });
    const reg = new FilePersonaRegistry(tmpRoot);
    await expect(reg.load('bad-json')).rejects.toThrow(/tools\.json is not valid JSON/);
    await expect(reg.load('bad-shape')).rejects.toThrow(/tools\.json must be/);
  });

  it('list 只返回含 prompt.md 的目录且排序', async () => {
    writePersona('zeta', { 'prompt.md': 'z' });
    writePersona('alpha', { 'prompt.md': 'a' });
    fs.mkdirSync(path.join(tmpRoot, 'no-prompt'), { recursive: true }); // 无 prompt.md 的目录不算人设
    const reg = new FilePersonaRegistry(tmpRoot);
    expect(reg.list()).toEqual(['alpha', 'zeta']);
  });

  it('根目录不存在时 list 返回空数组', () => {
    const reg = new FilePersonaRegistry(path.join(tmpRoot, 'does-not-exist'));
    expect(reg.list()).toEqual([]);
  });

  it('reload 失效缓存', async () => {
    writePersona('audit-expert', { 'prompt.md': 'v1' });
    const reg = new FilePersonaRegistry(tmpRoot);
    expect((await reg.load('audit-expert')).prompt).toBe('v1');
    writePersona('audit-expert', { 'prompt.md': 'v2' });
    expect((await reg.load('audit-expert')).prompt).toBe('v1'); // 缓存
    reg.reload('audit-expert');
    expect((await reg.load('audit-expert')).prompt).toBe('v2'); // 重新读取
  });

  it('仓库自带示例人设 personas/audit-expert 可加载（集成）', async () => {
    const repoPersonas = path.resolve(__dirname, '..', '..', 'personas');
    if (!fs.existsSync(path.join(repoPersonas, 'audit-expert', 'prompt.md'))) return; // 无示例则跳过
    const reg = new FilePersonaRegistry(repoPersonas);
    const p = await reg.load('audit-expert');
    expect(p.name).toBe('audit-expert');
    expect(p.prompt.length).toBeGreaterThan(0);
    expect(p.tools.length).toBeGreaterThan(0);
  });

  it('defaultPersonasRoot 在 configDir 下', () => {
    process.env.STUDIO_CONFIG_DIR = tmpRoot;
    expect(defaultPersonasRoot()).toBe(path.join(tmpRoot, 'personas'));
    delete process.env.STUDIO_CONFIG_DIR;
  });
});
