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

function defaultSkillsDir(): string {
  return process.env.STUDIO_SKILLS_DIR ?? path.join(os.homedir(), '.config', 'deepseek-studio', 'skills');
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
 * 确保技能目录存在（如果不存在则创建，并添加一个示例技能）。
 */
export function ensureSkillsDir(skillsDir?: string): string {
  const dir = skillsDir ?? defaultSkillsDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      // 创建示例技能
      const exampleDir = path.join(dir, 'example-skill');
      fs.mkdirSync(exampleDir, { recursive: true });
      fs.writeFileSync(
        path.join(exampleDir, 'SKILL.md'),
        `# 示例技能\n\n这是一个示例技能。把你的技能目录放在这里，每个技能一个子目录，包含 SKILL.md。\n\n## 使用方式\n\n当用户请求涉及本技能时，先读取本文件了解技能的 SOP 和约束，然后按照指引执行。\n`,
        'utf8',
      );
    }
  } catch {
    // 创建失败忽略
  }
  return dir;
}
