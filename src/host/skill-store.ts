/**
 * 本地技能系统（v1.0，移植自 deepseek++）
 *
 * 参考 deepseek++ 的技能目录结构：
 * - 每个技能是一个子目录，包含 SKILL.md（技能的 SOP、工具边界、约束）
 * - skill.list 扫描技能目录，返回可用技能列表
 * - 模型通过 file.read 读取 SKILL.md 内容，按照技能指引执行
 *
 * 默认技能目录：~/.config/deepseek-studio/skills/
 * 可通过 STUDIO_SKILLS_DIR 环境变量覆盖。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
 *   2. STUDIO_SKILLS_DIR 环境变量
 *   3. ~/.agents/skills（通用/Codex 技能根，存在则用）
 *   4. ~/.config/deepseek-studio/skills（本项目默认）
 */
export function resolveSkillsDir(explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const envDir = process.env.STUDIO_SKILLS_DIR?.trim();
  if (envDir) return envDir;
  const agentsDir = path.join(os.homedir(), '.agents', 'skills');
  try {
    if (fs.existsSync(agentsDir)) return agentsDir;
  } catch {
    // 访问失败则回落默认
  }
  return path.join(os.homedir(), '.config', 'deepseek-studio', 'skills');
}

function defaultSkillsDir(): string {
  return resolveSkillsDir();
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
export function scanSkills(skillsDir?: string): SkillInfo[] {
  const dir = skillsDir ?? defaultSkillsDir();
  const skills: SkillInfo[] = [];

  try {
    if (!fs.existsSync(dir)) return skills;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
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
 */
export function ensureSkillsDir(skillsDir?: string): string {
  const dir = skillsDir ?? defaultSkillsDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 创建失败忽略
  }
  return dir;
}
