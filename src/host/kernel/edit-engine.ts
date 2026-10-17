/**
 * C-1: edit-engine — unified diff 应用 + 多文件原子回滚。
 *
 * 核心设计：
 * 1. 写 tmp → journal → 逐枚 rename，失败逆序恢复
 * 2. 支持单文件替换（oldText → newText），比 unified diff 更可靠
 * 3. 多文件批量编辑时，任意一个失败都回滚所有已成功的文件
 */
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
 * 应用单条编辑指令（不做回滚）
 */
function applySingleEdit(workspace: string, instr: EditInstruction): { replacements: number; error?: string } {
  const absPath = join(workspace, instr.path);
  if (!existsSync(absPath)) {
    return { replacements: 0, error: `file not found: ${instr.path}` };
  }
  const content = readFileSync(absPath, 'utf-8');
  const count = content.split(instr.oldText).length - 1;
  if (count === 0) {
    return { replacements: 0, error: `oldText not found in ${instr.path}` };
  }
  if (count > 1) {
    return { replacements: 0, error: `oldText not unique in ${instr.path} (found ${count} times)` };
  }
  const newContent = content.replace(instr.oldText, instr.newText);
  writeFileSync(absPath + '.tmp', newContent, 'utf-8');
  renameSync(absPath + '.tmp', absPath);
  return { replacements: 1 };
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
      writeFileSync(absPath + '.tmp', newContent, 'utf-8');
      renameSync(absPath + '.tmp', absPath);
      applied.push({ absPath, originalContent });
      result.files.push({ path: instr.path, ok: true, replacements: 1 });
    } catch (e) {
      result.files.push({ path: instr.path, ok: false, replacements: 0, error: (e as Error).message });
      result.ok = false;
      // 逆序回滚
      for (const { absPath: rollPath, originalContent } of applied.reverse()) {
        try {
          writeFileSync(rollPath, originalContent, 'utf-8');
        } catch { /* ignore rollback error */ }
      }
      result.rolledBack = true;
      break;
    }
  }

  return result;
}
