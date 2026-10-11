/**
 * v0.12 Phase 2：自动化调度引擎
 *
 * 基于 node-cron 的定时任务调度器，支持：
 * - cron 表达式定时触发
 * - 任务持久化（JSON 文件存储）
 * - 执行日志记录
 * - 任务启用/禁用
 * - 通过 WebSocket 暴露管理 API
 */

import cron, { type ScheduledTask } from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// ── 类型定义 ───────────────────────────────────────────────────────────

export interface AutomationTask {
  id: string;
  name: string;
  description?: string;
  /** cron 表达式，如 "0 9 * * *"（每天 9 点） */
  cron: string;
  /** 任务类型：prompt（发送提示词）/ shell（执行命令）/ http（调用接口） */
  type: 'prompt' | 'shell' | 'http';
  /** 任务 payload，根据 type 不同 */
  payload: {
    /** type=prompt：要发送的提示词 */
    prompt?: string;
    /** type=shell：要执行的命令 */
    command?: string;
    /** type=http：URL + method + headers */
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastRunStatus?: 'success' | 'failed';
  lastRunError?: string;
  runCount: number;
}

export interface AutomationLogEntry {
  id: string;
  taskId: string;
  taskName: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'success' | 'failed';
  output?: string;
  error?: string;
}

export interface AutomationManager {
  list(): AutomationTask[];
  get(id: string): AutomationTask | undefined;
  create(input: Omit<AutomationTask, 'id' | 'createdAt' | 'updatedAt' | 'runCount'>): AutomationTask;
  update(id: string, patch: Partial<AutomationTask>): AutomationTask | undefined;
  remove(id: string): boolean;
  toggle(id: string, enabled: boolean): AutomationTask | undefined;
  runNow(id: string): Promise<AutomationLogEntry | undefined>;
  logs(taskId?: string, limit?: number): AutomationLogEntry[];
  start(): void;
  stop(): void;
}

// ── 实现 ───────────────────────────────────────────────────────────────

interface ScheduledTaskWrap {
  task: AutomationTask;
  job: ScheduledTask;
}

export function createAutomationManager(options?: {
  storageDir?: string;
  onTaskTrigger?: (task: AutomationTask) => Promise<void>;
}): AutomationManager {
  const storageDir =
    options?.storageDir ?? path.join(os.homedir(), '.config', 'deepseek-studio');
  const tasksFile = path.join(storageDir, 'automation-tasks.json');
  const logsFile = path.join(storageDir, 'automation-logs.json');

  let tasks: Map<string, AutomationTask> = new Map();
  let logs: AutomationLogEntry[] = [];
  let scheduled: Map<string, ScheduledTaskWrap> = new Map();
  let started = false;

  // ── 持久化 ─────────────────────────────────────────────────────────

  function ensureDir() {
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
  }

  function loadTasks() {
    try {
      if (fs.existsSync(tasksFile)) {
        const data = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        if (Array.isArray(data)) {
          tasks = new Map(data.map((t: AutomationTask) => [t.id, t]));
        }
      }
    } catch (err) {
      console.warn(`[automation] failed to load tasks: ${err}`);
    }
  }

  function saveTasks() {
    ensureDir();
    try {
      // 原子写：先写 .tmp 再 rename，避免崩溃留下半截 JSON
      const tmp = `${tasksFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...tasks.values()], null, 2), 'utf-8');
      fs.renameSync(tmp, tasksFile);
    } catch (err) {
      console.warn(`[automation] failed to save tasks: ${err}`);
    }
  }

  function loadLogs() {
    try {
      if (fs.existsSync(logsFile)) {
        const data = JSON.parse(fs.readFileSync(logsFile, 'utf-8'));
        if (Array.isArray(data)) {
          logs = data;
        }
      }
    } catch (err) {
      console.warn(`[automation] failed to load logs: ${err}`);
    }
  }

  function saveLogs() {
    ensureDir();
    try {
      // 只保留最近 500 条；原子写避免崩溃半截
      const trimmed = logs.slice(-500);
      const tmp = `${logsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf-8');
      fs.renameSync(tmp, logsFile);
    } catch (err) {
      console.warn(`[automation] failed to save logs: ${err}`);
    }
  }

  function addLog(entry: AutomationLogEntry) {
    logs.push(entry);
    saveLogs();
  }

  function updateLog(id: string, patch: Partial<AutomationLogEntry>) {
    const idx = logs.findIndex((l) => l.id === id);
    if (idx >= 0) {
      logs[idx] = { ...logs[idx], ...patch };
      saveLogs();
    }
  }

  // ── 任务执行 ───────────────────────────────────────────────────────

  async function executeTask(task: AutomationTask): Promise<AutomationLogEntry> {
    const logEntry: AutomationLogEntry = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      startedAt: Date.now(),
      status: 'running',
    };
    addLog(logEntry);

    try {
      let output = '';

      if (task.type === 'shell' && task.payload.command) {
        const { exec } = await import('node:child_process');
        output = await new Promise<string>((resolve, reject) => {
          exec(task.payload.command!, { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
          });
        });
      } else if (task.type === 'http' && task.payload.url) {
        const res = await fetch(task.payload.url, {
          method: task.payload.method || 'GET',
          headers: task.payload.headers,
          body: task.payload.body,
        });
        output = await res.text();
      } else if (task.type === 'prompt' && task.payload.prompt) {
        // prompt 类型由外部 onTaskTrigger 处理
        if (options?.onTaskTrigger) {
          await options.onTaskTrigger(task);
          output = `Prompt triggered: ${task.payload.prompt.slice(0, 100)}...`;
        } else {
          output = `Prompt queued (no handler): ${task.payload.prompt.slice(0, 100)}...`;
        }
      }

      updateLog(logEntry.id, {
        finishedAt: Date.now(),
        status: 'success',
        output,
      });

      // 更新任务统计
      task.lastRunAt = Date.now();
      task.lastRunStatus = 'success';
      task.runCount += 1;
      task.updatedAt = Date.now();
      saveTasks();

      return { ...logEntry, finishedAt: Date.now(), status: 'success', output };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      updateLog(logEntry.id, {
        finishedAt: Date.now(),
        status: 'failed',
        error,
      });

      task.lastRunAt = Date.now();
      task.lastRunStatus = 'failed';
      task.lastRunError = error;
      task.runCount += 1;
      task.updatedAt = Date.now();
      saveTasks();

      return { ...logEntry, finishedAt: Date.now(), status: 'failed', error };
    }
  }

  // ── 调度管理 ───────────────────────────────────────────────────────

  function scheduleTask(task: AutomationTask) {
    if (!cron.validate(task.cron)) {
      console.warn(`[automation] invalid cron expression for task ${task.id}: ${task.cron}`);
      return;
    }
    const job = cron.schedule(task.cron, () => {
      void executeTask(task);
    });
    scheduled.set(task.id, { task, job });
  }

  function unscheduleTask(id: string) {
    const s = scheduled.get(id);
    if (s) {
      s.job.stop();
      scheduled.delete(id);
    }
  }

  function rescheduleTask(task: AutomationTask) {
    unscheduleTask(task.id);
    if (task.enabled && started) {
      scheduleTask(task);
    }
  }

  // ── 公共 API ───────────────────────────────────────────────────────

  return {
    list() {
      return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    },

    get(id) {
      return tasks.get(id);
    },

    create(input) {
      const now = Date.now();
      const task: AutomationTask = {
        ...input,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        runCount: 0,
      };
      tasks.set(task.id, task);
      saveTasks();
      rescheduleTask(task);
      return task;
    },

    update(id, patch) {
      const task = tasks.get(id);
      if (!task) return undefined;
      const updated: AutomationTask = { ...task, ...patch, id, updatedAt: Date.now() };
      tasks.set(id, updated);
      saveTasks();
      rescheduleTask(updated);
      return updated;
    },

    remove(id) {
      unscheduleTask(id);
      const existed = tasks.delete(id);
      if (existed) saveTasks();
      return existed;
    },

    toggle(id, enabled) {
      return this.update(id, { enabled });
    },

    async runNow(id) {
      const task = tasks.get(id);
      if (!task) return undefined;
      return await executeTask(task);
    },

    logs(taskId, limit = 50) {
      let filtered = logs;
      if (taskId) {
        filtered = logs.filter((l) => l.taskId === taskId);
      }
      return filtered.slice(-limit).reverse();
    },

    start() {
      if (started) return;
      started = true;
      loadTasks();
      loadLogs();
      for (const task of tasks.values()) {
        if (task.enabled) {
          scheduleTask(task);
        }
      }
      console.log(`[automation] started, ${tasks.size} tasks loaded`);
    },

    stop() {
      for (const id of [...scheduled.keys()]) {
        unscheduleTask(id);
      }
      started = false;
      console.log('[automation] stopped');
    },
  };
}
