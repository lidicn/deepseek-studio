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
 * 把技能目录写回 `config.json`（**空串＝删除该键**，回落默认集合）。
 * 走 `persistConfigPatch` 以沿用既有原子写与 0600 权限（配置里可能有 token）。
 *
 * 为什么空串走 `undefined` 而不是写 `''`（0.14.20 收口）：
 * 写空串会在配置文件里留一个**空键**，用户看不懂、下一个人也得靠 `trim()` 才知道它等于没配；
 * `undefined` 在 `persistConfigPatch` 里是**删键**语义（见 `workspace.ts` 的合并分支）。
 */
export function persistSkillsDir(dir: string): { ok: boolean; error?: string } {
  const trimmed = dir.trim();
  return persistConfigPatch({ [SKILLS_DIR_CONFIG_KEY]: trimmed.length > 0 ? trimmed : undefined });
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
 * 解析技能**根目录集合**（0.14.20，出资人拍板：`~/.agents/skills` 与
 * `<configDir>/skills` **两个都要**，不是二选一）。
 *
 * 判定（顺序即优先级）：
 *   1. `explicit` / `STUDIO_SKILLS_DIR` / `config.json` 的 `skillsDir` **任一非空**
 *      ⇒ **只返回它一枚**（用户显式指定＝覆盖默认集合，行为与改前一致）；
 *   2. 否则默认集合**两枚都列**（**存在与否都列**——面板要把这两条路径显示给用户，
 *      告诉他技能该往哪放；跳过不存在的等于把路径藏起来）：
 *      - `~/.agents/skills`（跨客户端互操作约定，见 `resolveSkillsDir` 注释里的官方原文）
 *      - `<configDir>/skills`（装版 = `%APPDATA%\com.deepseek.studio\config\skills`）
 *
 * 为什么要多根：旧实现是**首匹配即返回**的单值链——`~/.agents/skills` 一存在就 `return`，
 * `<configDir>/skills` **永远走不到**，装版用户放在安装目录 `config\skills` 下的技能扫不到。
 */
export function resolveSkillRoots(explicit?: string, homedir: string = os.homedir()): string[] {
  const trimmed = explicit?.trim();
  if (trimmed) return [trimmed];
  const envDir = process.env.STUDIO_SKILLS_DIR?.trim();
  if (envDir) return [envDir];
  const configured = readConfiguredSkillsDir(homedir);
  if (configured) return [configured];
  return [agentsSkillsDir(homedir), path.join(resolveConfigDir(process.env, homedir), 'skills')];
}

/**
 * 解析技能目录（**单值**，向后兼容）：取 `resolveSkillRoots()` 的首根。
 *
 * 优先级与官方依据见 `resolveSkillRoots`。
 *
 * **2026-11-11 口径反转（用户拍板）**：装版**不再**跳过 `~/.agents/skills`。
 * 官方实施指南原文（`https://agentskills.io/client-implementation/adding-skills-support`）：
 *
 *   > The `.agents/skills/` paths **have emerged as a widely-adopted convention** for
 *   > cross-client skill sharing. While the Agent Skills specification **does not mandate**
 *   > where skill directories live (it only defines what goes inside them), scanning
 *   > `.agents/skills/` means skills installed by other compliant clients are automatically
 *   > visible to yours, and vice versa.
 *
 * 这句 "widely-adopted convention" 正是用户判据要的证据；本函数只做 `existsSync` 只读判断、
 * **绝不创建目录**（创建与否见 `ensureSkillsDir`），所以「怕污染用户机」的顾虑不成立。
 */
export function resolveSkillsDir(explicit?: string, homedir: string = os.homedir()): string {
  return resolveSkillRoots(explicit, homedir)[0];
}

/**
 * 「**本客户端自己**的默认技能目录」＝默认集合的**最后一根**（`<configDir>/skills`）。
 *
 * 为什么不是 `resolveSkillsDir()`（＝集合第一根 `~/.agents/skills`）：
 * 两者语义不同——**读**要广（跨客户端互操作目录也要扫），**建**要专（只在自己地盘建）。
 * `~/.agents/skills` 是**跨客户端共享约定目录**，任何客户端都不该"顺手"在里面创建；
 * 旧实现在 dev 下也只在它**已存在**时才复用、从不创建，本函数保持这条语义。
 */
function defaultSkillsDir(homedir?: string): string {
  const roots = resolveSkillRoots(undefined, homedir);
  return roots[roots.length - 1];
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
 *
 * 0.14.20：支持**多根**（`~/.agents/skills` ＋ `<configDir>/skills` 两个都要）。
 * 合并规则＝**同一个 `id`（目录名）先到先得**（roots 顺序即优先级），最后按 `name` 排序
 * （排序行为与改前一致，面板/`/` 弹层的展示顺序不变）。
 *
 * @param skillsDirs 单个目录或目录数组；缺省走 `resolveSkillRoots()`（默认集合）
 */
export function scanSkills(skillsDirs?: string | readonly string[], homedir?: string): SkillInfo[] {
  const roots =
    skillsDirs === undefined
      ? resolveSkillRoots(undefined, homedir)
      : (Array.isArray(skillsDirs) ? skillsDirs : [skillsDirs as string])
          .map((d) => d.trim())
          .filter((d) => d.length > 0);
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  for (const dir of roots) {
    scanOneRoot(dir, skills, seen);
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** 扫**一个**根目录，把新技能追加进 `out`；`seen` 保证同 id 先到先得。 */
function scanOneRoot(dir: string, out: SkillInfo[], seen: Set<string>): void {
  try {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // 同 id 先到先得：前面的根已经收过这个名字就不再覆盖（roots 顺序＝优先级）
      if (seen.has(entry.name)) continue;
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
        seen.add(entry.name);
        out.push({
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
    // 目录不可访问：跳过这一根，不影响其它根
  }
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
