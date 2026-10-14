/**
 * Persona 注册表（Bot 基础设施 · 副开发 CodeBuddy 负责）
 *
 * 契约来源：src/host/bot/types.ts（Claude 定义，签名锁定）。
 * 职责：扫描 personas/ 目录，加载人设包（prompt.md + tools.json + memory/）。
 *
 * 目录结构（见设计稿 §2.3）：
 *   personas/
 *   ├── audit-expert/
 *   │   ├── prompt.md          # 系统提示词（人设），必填
 *   │   ├── tools.json         # 工具白名单，可选；缺省 [] = 继承全部工具
 *   │   └── memory/            # 该人设专属持久记忆目录（路径解析，不强制存在）
 *
 * 根目录优先级：构造参数 > STUDIO_PERSONAS_DIR 环境变量 > <configDir>/personas。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Persona, PersonaRegistry } from './types';

/** 人设目录名安全 pattern：拒绝路径穿越（.. / / \ 一律不进）。 */
const PERSONA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 默认人设根目录：~/.config/deepseek-studio/personas */
export function defaultPersonasRoot(): string {
  const configDir =
    process.env.STUDIO_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'deepseek-studio');
  return path.join(configDir, 'personas');
}

function assertValidName(name: string): void {
  if (!name || !PERSONA_NAME_RE.test(name)) {
    throw new Error(`invalid persona name: ${JSON.stringify(name)} (allowed: [A-Za-z0-9._-], must start alnum)`);
  }
}

/** tools.json 合法形态：字符串数组，或 { tools: string[] }。 */
function parseToolsJson(raw: string, personaName: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`persona ${personaName}: tools.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { tools?: unknown }).tools)
      ? (parsed as { tools: unknown[] }).tools
      : null;
  if (!arr) {
    throw new Error(`persona ${personaName}: tools.json must be a string[] or { tools: string[] }`);
  }
  return arr.map((t) => {
    if (typeof t !== 'string' || !t) throw new Error(`persona ${personaName}: tools.json entries must be non-empty strings`);
    return t;
  });
}

/**
 * 基于文件系统的 PersonaRegistry 实现。
 * 加载结果按 name 缓存；目录内容变化后需调用 reload() 失效。
 */
export class FilePersonaRegistry implements PersonaRegistry {
  private readonly root: string;
  private readonly cache = new Map<string, Persona>();

  constructor(root?: string) {
    this.root = root ? path.resolve(root) : defaultPersonasRoot();
  }

  /** 人设根目录绝对路径。 */
  get rootDir(): string {
    return this.root;
  }

  /** 列出所有可用人设名（仅含 prompt.md 的目录）。 */
  list(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return []; // 根目录不存在 = 无人设
    }
    const names: string[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!PERSONA_NAME_RE.test(ent.name)) continue;
      if (fs.existsSync(path.join(this.root, ent.name, 'prompt.md'))) {
        names.push(ent.name);
      }
    }
    return names.sort();
  }

  /** 加载指定人设包；不存在或结构非法时抛错（契约：不存在时抛错）。 */
  async load(name: string): Promise<Persona> {
    assertValidName(name);
    const cached = this.cache.get(name);
    if (cached) return cached;

    const dir = path.join(this.root, name);
    const promptPath = path.join(dir, 'prompt.md');
    if (!fs.existsSync(promptPath)) {
      throw new Error(`persona not found: ${name} (expected ${promptPath})`);
    }
    const prompt = fs.readFileSync(promptPath, 'utf8');

    let tools: string[] = [];
    const toolsPath = path.join(dir, 'tools.json');
    if (fs.existsSync(toolsPath)) {
      tools = parseToolsJson(fs.readFileSync(toolsPath, 'utf8'), name);
    }

    const persona: Persona = {
      name,
      prompt,
      tools,
      memoryDir: path.join(dir, 'memory'),
    };
    this.cache.set(name, persona);
    return persona;
  }

  /** 失效缓存（指定 name 或全部），供目录热更新后重新加载。 */
  reload(name?: string): void {
    if (name) this.cache.delete(name);
    else this.cache.clear();
  }
}
