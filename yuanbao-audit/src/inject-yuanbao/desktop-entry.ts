/**
 * 元宝审计 · 自启动注入入口（Tauri initialization_script）
 *
 * 由 Tauri WebView 加载元宝页面时自动执行，不需要 token、不依赖 8761 后端：
 *   1. 等聊天区域出现
 *   2. 每 5s 扫描页面文本，检测 ROUND_N_DONE / ALL_DONE / NEED_* 信号
 *   3. 空闲 120s 自动发"继续"，生成中 300s 无变化也发，最多 5 次
 *   4. 右上角浮层实时显示：轮次 / 状态 / 最后活动
 *
 * 与 yuanbao-hook.ts 的区别：去掉 ReportClient（不上报 8761），直接自启动 + 浮层可见。
 */
import { detectSignals, mergeSignals, emptySignals, getChatText, type AuditSignals } from './signal-detector';
import { isGenerating, sendContinue } from './auto-continue';

const CHECK_INTERVAL = 5_000;
const STALL_TIMEOUT = 120_000;      // 空闲 120s 发"继续"
const NO_CHANGE_TIMEOUT = 300_000;  // 生成中 300s 无变化发"继续"
const MAX_CONTINUE = 5;

(function bootstrap(): void {
  // ── 环境伪装：去掉 WebView2 / Tauri 特征，伪装成桌面 Chrome ──────
  try {
    const fakeBrands = [
      { brand: 'Chromium', version: '147.0.0.0' },
      { brand: 'Google Chrome', version: '147.0.0.0' },
    ];
    const fakeUAD = {
      brands: fakeBrands,
      mobile: true,
      platform: 'Android',
      getHighEntropyValues: async () => ({
        brands: fakeBrands,
        mobile: true,
        platform: 'Android',
        platformVersion: '13.0.0',
        architecture: 'arm',
        bitness: '64',
        model: 'Pixel 7',
        uaFullVersion: '147.0.0.0',
        fullVersion: '147.0.0.0',
      }),
      toJSON: () => ({ brands: fakeBrands, mobile: true, platform: 'Android' }),
    };
    Object.defineProperty(navigator, 'userAgentData', { get: () => fakeUAD, configurable: true });
  } catch (e) { /* ignore */ }
  try { delete (window as any).__TAURI__; } catch (e) { /* ignore */ }
  try { (window as any).chrome = (window as any).chrome || {}; } catch (e) { /* ignore */ }

  const signals: AuditSignals = emptySignals();
  let continueCount = 0;
  let running = true;
  let lastTextLen = 0;
  let lastActivity = Date.now();
  let started = false;

  // ── 状态浮层 ──────────────────────────────────────────────────────
  const badge = document.createElement('div');
  badge.id = 'yuanbao-audit-badge';
  badge.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:99999',
    'padding:8px 12px', 'border-radius:8px', 'font:13px/1.5 system-ui,sans-serif',
    'background:#1f2329', 'color:#fff', 'box-shadow:0 2px 12px rgba(0,0,0,.3)',
    'pointer-events:auto', 'user-select:none', 'max-width:280px',
  ].join(';');
  document.documentElement.appendChild(badge);

  function setBadge(phase: string, color: string, extra?: string): void {
    const rounds = signals.rounds.size;
    badge.innerHTML =
      `<div style="font-weight:600;color:${color}">● 元宝审计 · ${phase}</div>` +
      `<div style="opacity:.85;margin-top:2px">已完成轮次：${rounds}</div>` +
      (extra ? `<div style="opacity:.6;font-size:11px;margin-top:2px">${extra}</div>` : '');
  }

  setBadge('等待聊天区', '#f5a623');

  // ── 扫描 ──────────────────────────────────────────────────────────
  function scan(): void {
    if (!running) return;
    const text = getChatText();
    const detected = detectSignals(text);
    const newRounds = mergeSignals(signals, detected);
    const generating = isGenerating();

    if (newRounds.length > 0) {
      lastActivity = Date.now();
      continueCount = 0;
    }

    // ALL_DONE
    if (signals.allDone && newRounds.length > 0) {
      running = false;
      setBadge('已完成 ALL_DONE', '#34a853', `共 ${signals.rounds.size} 轮`);
      return;
    }
    // NEED_DECISION → 停手等人
    if (signals.needDecision) {
      setBadge('待人工决策', '#e5484d', '窗口保持可见，请查看对话');
      return;
    }

    if (text.length !== lastTextLen) {
      lastTextLen = text.length;
      lastActivity = Date.now();
    }
    const idleFor = Date.now() - lastActivity;

    if (generating && idleFor >= NO_CHANGE_TIMEOUT) {
      if (continueCount < MAX_CONTINUE) {
        continueCount++;
        sendContinue('继续');
        lastActivity = Date.now();
        setBadge('生成中·催继续', '#f5a623', `第 ${continueCount}/${MAX_CONTINUE} 次`);
      }
      return;
    }

    if (!generating && idleFor >= STALL_TIMEOUT) {
      if (continueCount < MAX_CONTINUE) {
        continueCount++;
        const r = sendContinue('继续');
        if (r.ok) lastActivity = Date.now();
        setBadge('空闲·自动继续', '#f5a623', `第 ${continueCount}/${MAX_CONTINUE} 次`);
      } else {
        setBadge('已停手', '#e5484d', `连续 ${MAX_CONTINUE} 次无响应，等人工`);
        running = false;
      }
      return;
    }

    // 正常运行
    setBadge(
      generating ? '元宝生成中' : '监控中',
      generating ? '#3370ff' : '#34a853',
      `继续 ${continueCount}/${MAX_CONTINUE} · 空闲 ${Math.round(idleFor / 1000)}s`,
    );
  }

  function start(): void {
    if (started) return;
    started = true;
    const baseline = detectSignals(getChatText());
    mergeSignals(signals, baseline);
    lastTextLen = getChatText().length;
    lastActivity = Date.now();
    setBadge('监控中', '#34a853');
    setInterval(scan, CHECK_INTERVAL);
  }

  // 等聊天区域加载
  function waitForChat(): void {
    if (!running) return;
    if (getChatText().length >= 50) {
      start();
      return;
    }
    setTimeout(waitForChat, 1000);
  }

  // DOM ready 后开始
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForChat);
  } else {
    waitForChat();
  }

  // 兜底：10s 后无论如何开始（防止聊天区判断永远不满足）
  setTimeout(() => {
    if (!started) start();
  }, 10_000);
})();
