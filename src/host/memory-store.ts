/**
 * 本地记忆系统（v1.0，移植自 deepseek++）
 *
 * 参考 deepseek++ 的 memory_save 工具实现，提供：
 * - 记忆保存（memory_save）
 * - 记忆列表（用于注入系统提示词的 "Existing Memories" 部分）
 * - 本地 JSON 文件持久化存储
 *
 * 记忆类型：
 * - user：用户身份、偏好、习惯、技术栈
 * - project：项目信息、架构决策、重要约定
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type MemoryType = 'user' | 'project';

export interface Memory {
  /** 唯一 ID */
  readonly id: string;
  /** 记忆类型 */
  readonly type: MemoryType;
  /** 记忆名称（简短标题） */
  readonly name: string;
  /** 记忆内容（详细描述） */
  readonly content: string;
  /** 标签（用于检索和分类） */
  readonly tags: string[];
  /** 是否置顶 */
  readonly pinned: boolean;
  /** 创建时间戳 */
  readonly createdAt: number;
  /** 更新时间戳 */
  readonly updatedAt: number;
}

export interface SaveMemoryParams {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly tags?: string[];
  readonly pinned?: boolean;
}

export interface SaveMemoryResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
}

/** 默认记忆存储路径：~/.config/deepseek-studio/memories.json */
function defaultStorePath(): string {
  const configDir = process.env.STUDIO_CONFIG_DIR
    ?? path.join(os.homedir(), '.config', 'deepseek-studio');
  return path.join(configDir, 'memories.json');
}

function genId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidMemoryType(t: string): t is MemoryType {
  return t === 'user' || t === 'project';
}

/**
 * 记忆存储管理器。
 * 负责记忆的持久化读写、列表查询、格式化注入。
 */
export class MemoryStore {
  private memories: Memory[] = [];
  private readonly storePath: string;

  constructor(storePath?: string) {
    this.storePath = storePath ?? defaultStorePath();
    this.load();
  }

  /** 从磁盘加载记忆 */
  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.memories = parsed.filter((m) => m && typeof m.id === 'string');
        }
      }
    } catch (e) {
      console.warn('[memory] load failed, starting empty:', e instanceof Error ? e.message : String(e));
      this.memories = [];
    }
  }

  /** 保存到磁盘（原子写：tmp + rename，避免崩溃半截损坏） */
  private persist(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = `${this.storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.memories, null, 2), 'utf8');
      fs.renameSync(tmp, this.storePath);
    } catch (e) {
      console.error('[memory] persist failed:', e instanceof Error ? e.message : String(e));
    }
  }

  /** 保存一条记忆（如果同名同类型则更新） */
  save(params: SaveMemoryParams): SaveMemoryResult {
    // 验证类型
    if (!isValidMemoryType(params.type)) {
      return { ok: false, error: `invalid memory type: ${params.type} (expected 'user' or 'project')` };
    }
    // 验证必填字段
    if (!params.name || !params.content) {
      return { ok: false, error: 'name and content are required' };
    }

    const now = Date.now();
    const type = params.type as MemoryType;

    // 查找是否已存在同名同类型的记忆（更新而非重复）
    const existingIdx = this.memories.findIndex(
      (m) => m.type === type && m.name.toLowerCase() === params.name.toLowerCase(),
    );

    if (existingIdx >= 0) {
      // 更新已有记忆
      const existing = this.memories[existingIdx];
      this.memories[existingIdx] = {
        ...existing,
        content: params.content,
        tags: params.tags ?? existing.tags,
        pinned: params.pinned ?? existing.pinned,
        updatedAt: now,
      };
      this.persist();
      return { ok: true, id: existing.id };
    }

    // 创建新记忆
    const memory: Memory = {
      id: genId(),
      type,
      name: params.name,
      content: params.content,
      tags: params.tags ?? [],
      pinned: params.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.memories.push(memory);
    this.persist();
    return { ok: true, id: memory.id };
  }

  /** 获取所有记忆（置顶优先，然后按更新时间倒序） */
  list(): Memory[] {
    return [...this.memories].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  /** 删除一条记忆，返回是否成功 */
  remove(id: string): boolean {
    const idx = this.memories.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    this.memories.splice(idx, 1);
    this.persist();
    return true;
  }

  /**
   * 格式化为注入系统提示词的 "Existing Memories" 文本。
   * 参考 deepseek++ 的格式：- #id [type] name: content
   */
  formatForPrompt(limit = 50): string {
    const memories = this.list().slice(0, limit);
    if (memories.length === 0) return '(No memories yet)';
    return memories
      .map((m) => {
        const scope = m.type === 'project' ? 'project ' : '';
        return `- #${m.id} [${scope}${m.type}] ${m.name}: ${m.content}`;
      })
      .join('\n');
  }
}

/** 全局单例 */
let globalStore: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!globalStore) {
    globalStore = new MemoryStore();
  }
  return globalStore;
}
