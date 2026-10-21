/**
 * 元宝审计注入层 - 主入口
 *
 * 注入到 yuanbao.tencent.com 页面（document_start），
 * 负责：
 *   1. MutationObserver 监听对话 DOM，检测 ROUND_N_DONE / ALL_DONE / NEED_* 信号
 *   2. 空闲超时自动发送"继续"
 *   3. 向 yuanbao-audit Node 后端（:8761）报告状态
 *
 * 与 yuanbao_watcher.py 的区别：
 *   - 在页面 main world 内运行，不依赖 CDP/Playwright
 *   - 直接操作 DOM/React，不通过外部浏览器自动化
 *   - 状态通过 HTTP 上报，独立进程可独立重启
 */

import {
  detectSignals,
  emptySignals,
  getChatText,
  mergeSignals,
  type AuditSignals,
} from './signal-detector';
import { isGenerating, sendContinue } from './auto-continue';
import { ReportClient } from './report-client';

const CHECK_INTERVAL = 5000;       // 5 秒轮询
const STALL_TIMEOUT = 120_000;     // 空闲 120s 发"继续"
const MAX_CONTINUE = 5;            // 最多自动发 5 次
const NO_CHANGE_TIMEOUT = 300_000; // 生成中 300s 无变化发"继续"

export interface YuanbaoHookOptions {
  /** Node 后端 token */
  token: string;
  /** 项目名 */
  project?: string;
  /** Node 后端地址 */
  baseUrl?: string;
}

export interface YuanbaoHookHandle {
  stop(): void;
  getState(): { signals: AuditSignals; continueCount: number; running: boolean };
}

export function installYuanbaoHook(opts: YuanbaoHookOptions): YuanbaoHookHandle {
  const project = opts.project ?? 'default';
  const sessionUrl = location.href;
  const reporter = new ReportClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    project,
    sessionUrl,
  });

  const signals = emptySignals();
  let continueCount = 0;
  let running = true;
  let lastTextLen = getChatText().length;
  let lastActivity = Date.now();
  let lastNoChangeReport = 0;

  // 等待页面聊天区域加载
  function waitForChat(): void {
    const text = getChatText();
    if (text.length < 50) {
      setTimeout(waitForChat, 1000);
      return;
    }
    start();
  }

  function scan(): void {
    if (!running) return;

    const text = getChatText();
    const detected = detectSignals(text);
    const newRounds = mergeSignals(signals, detected);
    const generating = isGenerating();

    if (newRounds.length > 0) {
      lastActivity = Date.now();
      continueCount = 0;
      void reporter.reportUrgent({
        rounds: [...signals.rounds],
        state: signals.allDone ? 'done' : 'running',
        allDone: signals.allDone,
        needDecision: signals.needDecision,
        needContinue: signals.needContinue,
      });
    }

    // ALL_DONE → 完成
    if (signals.allDone && newRounds.length > 0) {
      running = false;
      void reporter.reportUrgent({
        rounds: [...signals.rounds],
        state: 'done',
        allDone: true,
        needDecision: false,
        needContinue: false,
      });
      return;
    }

    // NEED_DECISION → 暂停，不自动发
    if (signals.needDecision) {
      void reporter.report({
        rounds: [...signals.rounds],
        state: 'paused',
        allDone: false,
        needDecision: true,
        needContinue: signals.needContinue,
      });
      return;
    }

    // 文本变化检测
    if (text.length !== lastTextLen) {
      lastTextLen = text.length;
      lastActivity = Date.now();
    }

    const idleFor = Date.now() - lastActivity;

    // 生成中长时间无变化
    if (generating && idleFor >= NO_CHANGE_TIMEOUT) {
      if (continueCount < MAX_CONTINUE) {
        continueCount++;
        sendContinue('继续');
        lastActivity = Date.now();
      }
      return;
    }

    // 空闲超时 → 发"继续"
    if (!generating && idleFor >= STALL_TIMEOUT) {
      if (continueCount < MAX_CONTINUE) {
        continueCount++;
        const r = sendContinue('继续');
        if (r.ok) {
          lastActivity = Date.now();
        }
      } else {
        // 超过最大次数，暂停报告
        void reporter.reportUrgent({
          rounds: [...signals.rounds],
          state: 'paused',
          allDone: false,
          needDecision: true,
          needContinue: false,
        });
        running = false;
      }
    }

    // 定期心跳报告（每 30 秒）
    if (Date.now() - lastNoChangeReport > 30_000) {
      lastNoChangeReport = Date.now();
      void reporter.report({
        rounds: [...signals.rounds],
        state: generating ? 'running' : 'idle',
        allDone: signals.allDone,
        needDecision: signals.needDecision,
        needContinue: signals.needContinue,
      });
    }
  }

  let intervalId: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    // 初始扫描建立基线
    const text = getChatText();
    const baseline = detectSignals(text);
    mergeSignals(signals, baseline);
    lastTextLen = text.length;
    lastActivity = Date.now();

    intervalId = setInterval(scan, CHECK_INTERVAL);

    // MutationObserver 作为即时触发（比固定轮询响应更快）
    const observer = new MutationObserver(() => {
      if (running) {
        // DOM 变化时更新活动时间，但不立即扫描（节流由 interval 控制）
        lastActivity = Date.now();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  waitForChat();

  return {
    stop(): void {
      running = false;
      if (intervalId) clearInterval(intervalId);
    },
    getState(): { signals: AuditSignals; continueCount: number; running: boolean } {
      return { signals, continueCount, running };
    },
  };
}
