/**
 * ds-stop-control.ts —— DeepSeek 页面「停止生成」按钮识别 + 生成态判定。
 *
 * 为什么需要（真机 dump 得到的特征，不是猜的）：
 *   - 停止键独有：`ds-button--outlined` / `ds-button--outlinedNeutral`（+60，阈值 60）
 *   - 发送键独有：`ds-button--filled` / `ds-button--primary`（命中即**排除**，不给分）
 *   - `ds-button--circle` 停止键与发送键**都有**（+10），不能靠它区分
 *   - **生成中发送键不会消失** —— 不能写「发送键消失 = 正在生成」
 *   - DeepSeek 的停止键是纯图标：没有文字、没有 aria-label，`aria-label*="停止"`
 *     永远匹配不到 → 判据里禁止用 aria-label / 文本
 *   - 分数并列时返回 `no-stop-control`：宁可不动作，也绝不误点
 *     「深度思考」/「智能搜索」这类同为 outlined 的开关
 *
 * 本模块只做**识别**，不点击：点击是不可逆动作，识别与执行分开，
 * 让调用方自己决定要不要动手、要不要先跟用户确认。
 */

/** 命中停止键独有类名的加分。 */
export const STOP_EXCLUSIVE_SCORE = 60;
/** 停止键/发送键共有的圆形类名，只用于打破并列，不足以单独定性。 */
export const SHARED_BUTTON_SCORE = 10;
/** 判定为停止键所需的最低分（等于 STOP_EXCLUSIVE_SCORE：必须命中停止键独有类名）。 */
export const STOP_CONTROL_THRESHOLD = STOP_EXCLUSIVE_SCORE;

/** 停止键独有：命中即强证据。 */
export const STOP_EXCLUSIVE_CLASSES = ['ds-button--outlined', 'ds-button--outlinedNeutral'] as const;
/** 发送键独有：命中即排除（宁可漏判，绝不把发送键当停止键）。 */
export const SEND_EXCLUSIVE_CLASSES = ['ds-button--filled', 'ds-button--primary'] as const;
/** 两者共有：只加分，不定性。 */
export const SHARED_BUTTON_CLASSES = ['ds-button--circle'] as const;

/** 只关心带 ds-button--* 类名的元素（避免把页面其它节点当候选）。 */
const CANDIDATE_SELECTOR = '[class*="ds-button--"]';

export interface StopControlCandidate {
  readonly element: Element;
  /** 候选得分（被排除的候选恒为 0）。 */
  readonly score: number;
  /** 是否因命中发送键独有类名而被排除。 */
  readonly excluded: boolean;
  /** 实际命中的类名，便于取证与排障。 */
  readonly matchedClasses: readonly string[];
}

export type StopControlStatus = 'stop-control' | 'no-stop-control';

export interface StopControlDetection {
  readonly status: StopControlStatus;
  /** 唯一命中的停止键；无或有并列时为 null。 */
  readonly element: Element | null;
  /** 最高分（并列时也是该分）。 */
  readonly score: number;
  /** 判定理由（取证用）。 */
  readonly reason: string;
  readonly candidates: readonly StopControlCandidate[];
}

/** 取元素上的类名集合；SVG 等非 HTMLElement 也能安全处理。 */
function classTokensOf(element: Element): readonly string[] {
  const raw = element.getAttribute('class') ?? '';
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * 给单个候选打分。
 *
 * 规则（顺序即优先级）：
 *   1. 命中发送键独有类名 → 直接排除，0 分（命中即排除，不给分）；
 *   2. 否则命中停止键独有类名 → +60；
 *   3. 命中共有类名 → +10（只用于打破并列）。
 */
export function scoreStopControlCandidate(element: Element): StopControlCandidate {
  const tokens = classTokensOf(element);
  const has = (cls: string): boolean => tokens.includes(cls);

  const matched: string[] = [];
  let excluded = false;
  for (const cls of SEND_EXCLUSIVE_CLASSES) {
    if (has(cls)) {
      excluded = true;
      matched.push(cls);
    }
  }
  if (excluded) {
    return { element, score: 0, excluded: true, matchedClasses: matched };
  }

  let score = 0;
  // 按**类别**计一次分：ds-button--outlined 与 ds-button--outlinedNeutral 是同一类
  // 证据（不同版本页面的两种写法），同时出现也不该叠成 120 分。
  if (STOP_EXCLUSIVE_CLASSES.some((cls) => has(cls))) {
    score += STOP_EXCLUSIVE_SCORE;
    matched.push(...STOP_EXCLUSIVE_CLASSES.filter((cls) => has(cls)));
  }
  if (SHARED_BUTTON_CLASSES.some((cls) => has(cls))) {
    score += SHARED_BUTTON_SCORE;
    matched.push(...SHARED_BUTTON_CLASSES.filter((cls) => has(cls)));
  }
  return { element, score, excluded: false, matchedClasses: matched };
}

/**
 * 在给定根节点内识别停止键。
 *
 * 返回 `no-stop-control` 的情形（都不动作）：
 *   - 页面里根本没有候选；
 *   - 有候选但没人过阈值（例如只有 circle、只有发送键）；
 *   - 有多个候选并列最高分（例如「深度思考」开关和停止键同为 outlined+circle）。
 *
 * @param root 查找范围，默认 document。
 */
export function detectStopControl(root?: ParentNode): StopControlDetection {
  const scope: ParentNode | null = root
    ?? (typeof document !== 'undefined' ? document : null);
  if (!scope) {
    return { status: 'no-stop-control', element: null, score: 0, reason: 'no-root', candidates: [] };
  }

  const candidates = Array.from(scope.querySelectorAll(CANDIDATE_SELECTOR))
    .map(scoreStopControlCandidate);

  const qualified = candidates.filter((c) => !c.excluded && c.score >= STOP_CONTROL_THRESHOLD);
  if (qualified.length === 0) {
    return {
      status: 'no-stop-control',
      element: null,
      score: 0,
      reason: candidates.length === 0 ? 'no-candidate' : 'below-threshold',
      candidates,
    };
  }

  const top = qualified.reduce((max, c) => Math.max(max, c.score), 0);
  const winners = qualified.filter((c) => c.score === top);
  if (winners.length > 1) {
    // 并列：宁可不动作，也绝不误点同级开关。
    return { status: 'no-stop-control', element: null, score: top, reason: 'tied-candidates', candidates };
  }
  return {
    status: 'stop-control',
    element: winners[0].element,
    score: top,
    reason: 'unique-qualified',
    candidates,
  };
}

/**
 * 生成态判定：**只看停止键在不在**。
 *
 * 明确不做的事：
 *   - 不看 aria-label / 按钮文字（DeepSeek 停止键是纯图标，没有可读文本）；
 *   - 不看发送键是否消失（生成中发送键照样在）。
 */
export function isGenerating(root?: ParentNode): boolean {
  return detectStopControl(root).status === 'stop-control';
}
