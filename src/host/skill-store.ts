/**
 * 本地技能系统（v1.0，移植自 deepseek++）
 *
 * 参考 deepseek++ 的技能目录结构：
 * - 每个技能是一个子目录，包含 SKILL.md（技能的 SOP、工具边界、约束）
 * - skill.list 扫描技能目录，返回可用技能列表
 * - 模型通过 file.read 读取 SKILL.md 内容，按照技能指引执行
 *
 * 默认技能目录：见 `resolveSkillsDir()`（2026-11-11 起含 `~/.agents/skills` 互操作位）。
 * 可通过 STUDIO_SKILLS_DIR 环境变量或设置面板「技能目录」覆盖。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveConfigDir, isInstalledDistribution } from '../shared/distribution';
import { defaultConfigPath, persistConfigPatch } from './workspace';

/** `config.json` 里保存「用户指定的技能目录」的键。 */
export const SKILLS_DIR_CONFIG_KEY = 'skillsDir';

/** `~/.agents/skills`：Agent Skills 跨客户端互操作约定目录（用户级）。 */
export function agentsSkillsDir(homedir: string = os.homedir()): string {
  return path.join(homedir, '.agents', 'skills');
}

/**
 * 读 `config.json` 里保存的技能目录（无该键 / 空串 / 读失败 → `null`）。
 *
 * 为什么需要它（真机现场 2026-11-11）：设置页「技能目录」输入框过去只把路径当**单次调用参数**
 * （`skill.list {dir}`）——面板自己看得见，但 `/` 弹层与 interceptor 传的是 `{}`、走默认链，
 * 而用户填的路径**从未落盘**。于是「设置页列出 12 个技能，`/` 弹层恒为空」，重开面板又回落默认值。
 */
export function readConfiguredSkillsDir(homedir: string = os.homedir()): string | null {
  try {
    const raw = fs.readFileSync(defaultConfigPath(homedir), 'utf8');
    const bag = JSON.parse(raw) as Record<string, unknown>;
    const value = bag[SKILLS_DIR_CONFIG_KEY];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // 配置不存在 / 非法 JSON / 读失败：一律视为「未配置」，回落默认链。
    return null;
  }
}

/**
 * 把技能目录写回 `config.json`（空串＝清除，回落默认链）。
 * 走 `persistConfigPatch` 以沿用既有原子写与 0600 权限（配置里可能有 token）。
 */
export function persistSkillsDir(dir: string): { ok: boolean; error?: string } {
  return persistConfigPatch({ [SKILLS_DIR_CONFIG_KEY]: dir.trim() });
}

export interface SkillInfo {
  /** 技能 ID（目录名） */
  readonly id: string;
  /** 技能名称（从 SKILL.md 的一级标题提取，或用目录名） */
  readonly name: string;
  /** 技能描述（从 SKILL.md 的 frontmatter 或第一段提取） */
  readonly description: string;
  /** SKILL.md 的绝对路径 */
  readonly skillMdPath: string;
}

/**
 * 解析技能目录，优先级：
 *   1. 显式传入（面板扫描时输入框里的路径）
 *   2. `STUDIO_SKILLS_DIR` 环境变量
 *   3. `config.json` 里保存的 `skillsDir`（设置面板「扫描」写入）
 *   4. `~/.agents/skills`（Agent Skills 跨客户端互操作约定，存在则用）
 *   5. `<STUDIO_CONFIG_DIR>/skills`（本项目默认；缺省 `~/.config/deepseek-studio/skills`）
 *
 * **2026-11-11 口径反转（用户拍板）**：装版**不再**跳过第 ④ 位。
 * 依据是 Agent Skills 官方实施指南（agentskills.io/client-implementation/adding-skills-support）：
 * `.agents/skills/` 是「跨客户端共享技能的广泛采纳约定」，官方明确要求 User scope 扫
 * `~/.agents/skills/`；规范本身只定义 `SKILL.md` 内容、不规定目录位置，**不扫**就等于
 * 看不到别的合规客户端装的技能。原「装版不猜」的顾虑是**怕污染用户机**，而本函数只做
 * `existsSync` 判断、绝不创建目录（创建与否见 `ensureSkillsDir`），该顾虑不成立。
 */
export function resolveSkillsDir(explicit?: string, homedir: string = os.homedir()): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const envDir = process.env.STUDIO_SKILLS_DIR?.trim();
  if (envDir) return envDir;
  const configured = readConfiguredSkillsDir(homedir);
  if (configured) return configured;
  try {
    const agentsDir = agentsSkillsDir(homedir);
    if (fs.existsSync(agentsDir)) return agentsDir;
  } catch {
    // 目录不可访问（权限 / IO）：不阻断，回落客户端原生目录
  }
  return path.join(resolveConfigDir(process.env, homedir), 'skills');
}

function defaultSkillsDir(homedir?: string): string {
  return resolveSkillsDir(undefined, homedir);
}

/**
 * 从 SKILL.md 内容中提取名称和描述。
 * 名称：第一个一级标题（# Title）
 * 描述：frontmatter 中的 description，或第一段非标题文本
 */
function parseSkillMd(content: string): { name: string; description: string } {
  let name = '';
  let description = '';

  // 提取 frontmatter（--- 之间的 YAML）
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const descMatch = fm.match(/description:\s*(.+)/i);
    if (descMatch) description = descMatch[1].trim();
    const nameMatch = fm.match(/name:\s*(.+)/i);
    if (nameMatch) name = nameMatch[1].trim();
  }

  // 提取一级标题作为名称
  if (!name) {
    const titleMatch = content.match(/^#\s+(.+)/m);
    if (titleMatch) name = titleMatch[1].trim();
  }

  // 提取第一段非标题、非空行作为描述
  if (!description) {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---') && !trimmed.startsWith('>')) {
        description = trimmed.slice(0, 200);
        break;
      }
    }
  }

  return { name, description };
}

/**
 * 扫描技能目录，返回可用技能列表。
 * 每个技能必须是包含 SKILL.md 的子目录。
 */
export function scanSkills(skillsDir?: string, homedir?: string): SkillInfo[] {
  const dir = skillsDir ?? defaultSkillsDir(homedir);
  const skills: SkillInfo[] = [];

  try {
    if (!fs.existsSync(dir)) return skills;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const skillDir = path.join(dir, entry.name);
      // readdirSync(withFileTypes) 对 junction / symlink 只报 isSymbolicLink()，
      // isDirectory() 为 false。技能目录经常用 junction 挂载（如 ego-browser），
      // 直接跳过会导致技能面板和 `/` 提示都看不到它，所以这里用 statSync 跟随链接。
      let isDirectory = entry.isDirectory();
      if (!isDirectory) {
        try {
          isDirectory = fs.statSync(skillDir).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (!isDirectory) continue;
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      try {
        const content = fs.readFileSync(skillMd, 'utf8');
        const { name, description } = parseSkillMd(content);
        skills.push({
          id: entry.name,
          name: name || entry.name,
          description: description || '(无描述)',
          skillMdPath: skillMd,
        });
      } catch {
        // 读取失败的技能跳过
      }
    }
  } catch {
    // 目录不可访问，返回空列表
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 确保技能目录存在（不存在则创建空目录）。
 * 不写入任何示例技能——目录内容应完全来自用户，避免"假技能"混进列表。
 *
 * **装版不建**（批 N+1，D 组，设计稿 §8.4）：装版首启不得在 `<config>/skills` 下凭空
 * 出现一个空目录（用户视角「我什么都没配，凭什么多一个目录」）。
 * 因此**只有显式传入 `skillsDir`（面板「添加技能目录」）时才创建**；
 * 装版缺省路径只返回、不落盘。dev 行为逐字节不变。
 */
export function ensureSkillsDir(skillsDir?: string, homedir?: string): string {
  const explicit = skillsDir?.trim();
  const dir = explicit || defaultSkillsDir(homedir);
  // 装版 + 非显式请求 → 只解析不建目录（显式请求是用户在面板上的明确动作，照旧创建）
  if (!explicit && isInstalledDistribution()) return dir;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 创建失败忽略
  }
  return dir;
}
