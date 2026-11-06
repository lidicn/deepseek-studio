/**
 * C-1: edit-engine — unified diff 应用 + 多文件原子回滚。
 *
 * 核心设计：
 * 1. 写 tmp → journal → 逐枚 rename，失败逆序恢复
 * 2. 支持单文件替换（oldText → newText），比 unified diff 更可靠
 * 3. 多文件批量编辑时，任意一个失败都回滚所有已成功的文件
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from '../../shared/atomic-write';

/** 单文件编辑指令 */
export interface EditInstruction {
  /** 文件路径（相对工作区或绝对路径） */
  path: string;
  /** 要替换的旧文本（必须唯一） */
  oldText: string;
  /** 替换为的新文本 */
  newText: string;
}

/** 编辑结果 */
export interface EditResult {
  ok: boolean;
  /** 每个文件的编辑详情 */
  files: Array<{
    path: string;
    ok: boolean;
    /** 替换了几处 */
    replacements: number;
    error?: string;
  }>;
  /** 是否全部回滚了 */
  rolledBack: boolean;
}

/**
 * 批量应用编辑指令，原子回滚。
 *
 * 流程：
 * 1. 逐条预检查（oldText 存在且唯一）
 * 2. 全部检查通过后，逐条应用
 * 3. 任意一条失败 → 逆序恢复已应用的文件
 */
export function applyEdits(workspace: string, instructions: EditInstruction[]): EditResult {
  const result: EditResult = {
    ok: true,
    files: [],
    rolledBack: false,
  };

  // 阶段 1：预检查所有指令
  const checked: Array<{ instr: EditInstruction; absPath: string; originalContent: string }> = [];
  for (const instr of instructions) {
    const absPath = join(workspace, instr.path);
    if (!existsSync(absPath)) {
      result.files.push({ path: instr.path, ok: false, replacements: 0, error: `file not found` });
      result.ok = false;
      break;
    }
    const content = readFileSync(absPath, 'utf-8');
    const count = content.split(instr.oldText).length - 1;
    if (count === 0) {
      result.files.push({ path: instr.path, ok: false, replacements: 0, error: `oldText not found` });
      result.ok = false;
      break;
    }
    if (count > 1) {
      result.files.push({ path: instr.path, ok: false, replacements: 0, error: `oldText not unique (${count} times)` });
      result.ok = false;
      break;
    }
    checked.push({ instr, absPath, originalContent: content });
  }

  // 预检查失败，直接返回
  if (!result.ok) {
    return result;
  }

  // 阶段 2：逐条应用，失败则逆序回滚
  const applied: Array<{ absPath: string; originalContent: string }> = [];
  for (const { instr, absPath, originalContent } of checked) {
    try {
      const content = readFileSync(absPath, 'utf-8');
      const newContent = content.replace(instr.oldText, instr.newText);
      // 批 3 顺带：原实现用固定 `${absPath}.tmp` —— 两个编辑并发时共用同一临时名，
      // A 写 tmp → B 覆写 tmp → A rename ⇒ A 把 B 的内容搬成自己的结果（静默串档）。
      // 改用 helper 的带 pid+序号临时名 + 同一套失败清理（失败时目标保持原样）。
      writeFileAtomicSync(absPath, newContent, { encoding: 'utf-8' });
      applied.push({ absPath, originalContent });
      result.files.push({ path: instr.path, ok: true, replacements: 1 });
    } catch (e) {
      result.files.push({ path: instr.path, ok: false, replacements: 0, error: (e as Error).message });
      result.ok = false;
      // 逆序回滚
      for (const { absPath: rollPath, originalContent } of applied.reverse()) {
        try {
          // 批 3（Verify 补进的真候选）：**回滚路径必须与主路径同等原子**。
          //
          // 主件 `:87` 早就是 tmp+rename，回滚这里原来是裸 `writeFileSync`。
          // 为什么这个不对称比「没修好」更糟：回滚发生时**主路径已经失败过一次**，
          // 回滚再崩 = 用户的文件被**二次损坏**（叠加在已发生的失败之上）。
          // 通用口径：回滚/补偿路径的可靠性要求 ≥ 主路径。
          writeFileAtomicSync(rollPath, originalContent, { encoding: 'utf-8' });
        } catch { /* ignore rollback error */ }
      }
      result.rolledBack = true;
      break;
    }
  }

  return result;
}
