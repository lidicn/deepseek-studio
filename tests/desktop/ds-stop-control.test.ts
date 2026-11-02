// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectStopControl,
  isGenerating,
  scoreStopControlCandidate,
  STOP_CONTROL_THRESHOLD,
} from '../../src/inject/ds-stop-control';

/**
 * 停止键 / 生成态识别。
 *
 * 判据来自真机 dump（不是猜的）：
 *   - 停止键独有：ds-button--outlined / ds-button--outlinedNeutral（+60，阈值 60）
 *   - 发送键独有：ds-button--filled / ds-button--primary（命中即排除）
 *   - ds-button--circle 两者共有（+10），不能靠它区分
 *   - 生成中发送键不会消失 → 不能用「发送键消失」判生成
 *   - 停止键是纯图标 → 不能靠 aria-label / 文字
 *   - 并列 → no-stop-control，宁可不动作
 */

const STOP_BTN = 'ds-button ds-button--circle ds-button--outlinedNeutral';
const STOP_BTN_PLAIN = 'ds-button ds-button--outlined';
const SEND_BTN = 'ds-button ds-button--circle ds-button--filled ds-button--primary';
const TOGGLE_BTN = 'ds-button ds-button--outlined';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function btn(cls: string, extra = ''): string {
  return `<button class="${cls}" ${extra}></button>`;
}

describe('ds-stop-control：停止键识别与生成态判定', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // ── 形态一：停止键在 ────────────────────────────────
  it('停止键在（outlined+circle，唯一）→ 识别为 stop-control，生成态为真', () => {
    mount(`<div id="composer">${btn(STOP_BTN)}</div>`);

    const d = detectStopControl();
    expect(d.status).toBe('stop-control');
    expect(d.element).not.toBeNull();
    expect(d.element!.getAttribute('class')).toContain('ds-button--outlined');
    expect(d.score).toBe(70); // 60（outlined）+ 10（circle）
    expect(d.reason).toBe('unique-qualified');
    expect(isGenerating()).toBe(true);
  });

  it('停止键在但没有 circle（恰好 60 分）→ 仍然识别为停止键', () => {
    mount(btn(STOP_BTN_PLAIN));

    const d = detectStopControl();
    expect(d.status).toBe('stop-control');
    expect(d.score).toBe(STOP_CONTROL_THRESHOLD);
    expect(isGenerating()).toBe(true);
  });

  it('停止键是纯图标：没有文字也没有 aria-label，依然能识别', () => {
    mount(btn(STOP_BTN));
    const el = document.querySelector('button')!;
    expect(el.textContent).toBe('');
    expect(el.getAttribute('aria-label')).toBeNull();

    expect(detectStopControl().status).toBe('stop-control');
  });

  // ── 形态二：停止键不在 ──────────────────────────────
  it('停止键不在（页面只有普通按钮）→ no-stop-control，不判生成', () => {
    mount('<button class="ds-button ds-button--ghost"></button><button>普通</button>');

    const d = detectStopControl();
    expect(d.status).toBe('no-stop-control');
    expect(d.element).toBeNull();
    expect(d.reason).toBe('below-threshold');
    expect(isGenerating()).toBe(false);
  });

  it('页面里根本没有 ds-button 候选 → no-stop-control（no-candidate）', () => {
    mount('<button>发送</button><input placeholder="给 DeepSeek 发送消息">');

    const d = detectStopControl();
    expect(d.status).toBe('no-stop-control');
    expect(d.reason).toBe('no-candidate');
    expect(d.candidates).toHaveLength(0);
  });

  it('只有 aria-label="停止" 的按钮不算停止键（禁止靠 aria-label 判定）', () => {
    mount(btn('ds-button', 'aria-label="停止" title="停止"'));

    const d = detectStopControl();
    expect(d.status).toBe('no-stop-control');
    expect(isGenerating()).toBe(false);
  });

  // ── 形态三：只有 circle ─────────────────────────────
  it('只有 circle（停止键/发送键共有）→ 10 分不足阈值 → no-stop-control', () => {
    mount(btn('ds-button ds-button--circle'));

    const d = detectStopControl();
    expect(d.status).toBe('no-stop-control');
    expect(d.candidates[0].score).toBe(10);
    expect(d.candidates[0].excluded).toBe(false);
    expect(isGenerating()).toBe(false);
  });

  it('circle + 停止键独有类名 → 70 分，唯一最高分时选中停止键', () => {
    mount(`${btn('ds-button ds-button--circle')}${btn(STOP_BTN)}`);

    const d = detectStopControl();
    expect(d.status).toBe('stop-control');
    expect(d.score).toBe(70);
    expect(d.element!.getAttribute('class')).toContain('ds-button--outlined');
  });

  // ── 形态四：只有 filled（发送键） ───────────────────
  it('只有 filled/primary（发送键）→ 命中即排除 → no-stop-control', () => {
    mount(btn(SEND_BTN));

    const d = detectStopControl();
    expect(d.status).toBe('no-stop-control');
    expect(d.candidates[0].excluded).toBe(true);
    expect(d.candidates[0].score).toBe(0);
    expect(d.candidates[0].matchedClasses).toContain('ds-button--filled');
    expect(isGenerating()).toBe(false);
  });

  it('生成中发送键仍在场：发送键存在 ≠ 生成中（不靠发送键消失判定）', () => {
    mount(`${btn(SEND_BTN)}${btn('ds-button ds-button--circle')}`);

    const d = detectStopControl();
    expect(d.status).toBe('no-stop-control');
    expect(d.candidates.some((c) => c.excluded)).toBe(true);
    expect(isGenerating()).toBe(false);
  });

  it('同一元素同时带 outlined 与 filled → 发送键命中即排除', () => {
    mount(btn('ds-button ds-button--outlined ds-button--filled'));

    const d = detectStopControl();
    expect(d.status).toBe('no-stop-control');
    expect(d.candidates[0].excluded).toBe(true);
  });

  // ── 并列：宁可不动作 ────────────────────────────────
  it('两个候选并列最高分 → no-stop-control（宁可不动作，绝不误点同级开关）', () => {
    mount(`${btn(STOP_BTN)}${btn('ds-button ds-button--circle ds-button--outlined')}`);

    const d = detectStopControl();
    expect(d.status).toBe('no-stop-control');
    expect(d.element).toBeNull();
    expect(d.reason).toBe('tied-candidates');
    expect(d.score).toBe(70);
    expect(isGenerating()).toBe(false);
  });

  it('停止键(70) 与同级开关(60) 不同分 → 取唯一最高分的停止键', () => {
    mount(`${btn(STOP_BTN)}${btn(TOGGLE_BTN)}`);

    const d = detectStopControl();
    expect(d.status).toBe('stop-control');
    expect(d.score).toBe(70);
    expect(isGenerating()).toBe(true);
  });

  // ── 范围与打分细节 ──────────────────────────────────
  it('只在给定 root 子树内查找，不受页面其它区域干扰', () => {
    mount(`<div id="outside">${btn(STOP_BTN)}</div><div id="inside"></div>`);
    const inside = document.querySelector('#inside')!;

    expect(detectStopControl().status).toBe('stop-control');
    expect(detectStopControl(inside).status).toBe('no-stop-control');
    expect(detectStopControl(inside).reason).toBe('no-candidate');
  });

  it('scoreStopControlCandidate：停止键类名 +60、circle +10、发送键类名 0 分且排除', () => {
    const stop = document.createElement('button');
    stop.className = STOP_BTN;
    const s = scoreStopControlCandidate(stop);
    expect(s.score).toBe(70);
    expect(s.excluded).toBe(false);

    const send = document.createElement('button');
    send.className = SEND_BTN;
    const t = scoreStopControlCandidate(send);
    expect(t.score).toBe(0);
    expect(t.excluded).toBe(true);
  });

  it('ds-button--outlinedNeutral 与 ds-button--outlined 按精确类名匹配，互不串味', () => {
    const neutral = document.createElement('button');
    neutral.className = 'ds-button ds-button--outlinedNeutral';
    expect(scoreStopControlCandidate(neutral).score).toBe(60);

    const plain = document.createElement('button');
    plain.className = 'ds-button ds-button--outlined';
    expect(scoreStopControlCandidate(plain).score).toBe(60);

    const unrelated = document.createElement('button');
    unrelated.className = 'ds-button ds-button--outlinedish';
    expect(scoreStopControlCandidate(unrelated).score).toBe(0);

    // 两个变体同时出现：同一类证据，不叠分（60 而不是 120）。
    const both = document.createElement('button');
    both.className = 'ds-button ds-button--outlined ds-button--outlinedNeutral';
    expect(scoreStopControlCandidate(both).score).toBe(60);
  });
});
