/**
 * R0-R2 / R0-R5：上游响应分类器（纯模块，无 DOM / 运行时依赖，便于单测）。
 *
 * 原 auto-continue/nudge 路径只识别 429，其余（status=0 网络错误、5xx、200 错误 JSON、
 * SSE error 帧）全部落入「空回复」分支，被当成「模型没说完」继续 nudge，叠加续跑预算形成
 * 33 连发。这里把响应显式分为 ok / retryable / fatal / quota-exhausted 四类：
 *   - ok        正常完成，走既有续跑/nudge 决策
 *   - retryable 可重试（429 限流、status=0 断连、5xx、SSE 错误载荷），消耗独立错误预算
 *   - fatal     不可重试（401/403 鉴权、402/欠费、400 参数错误），立即停手并上报
 *   - quota-exhausted 额度墙（㊿-c①）：200 外壳套 data 层 biz_code:29／配额耗尽，不可重试，
 *     明示恢复时刻＋透传上游 alert 文案（见 detectQuotaWall / composeQuotaWallMessage）
 *
 * 另含：错误重试指数退避、重放请求头白名单（R0-R3）、错误遥测环形缓冲（R0-R5）。
 */

export type ResponseVerdict = 'ok' | 'retryable' | 'fatal' | 'quota-exhausted' | 'challenge-required' | 'auth-invalid';

/**
 * 额度墙（quota-exhausted）元数据。上游配额用尽时回 HTTP 200 外壳套 data 层：
 * `biz_code:29` ＋ `quotas[0]{is_exhausted:true, reset_at:<秒级 float>, msg}` ＋ 上游自带
 * `alert{title,description,buttons}`。外层 `code:0` 会骗过只看 HTTP 状态码／外层 code 的
 * 分类器（误判成「正常」→ 无完成哨兵再降级 stream-incomplete 连接中断并自动重试）。
 * 本结构是额度墙识别与文案组合的唯一真源。
 */
export interface QuotaWallInfo {
  /** 上游业务码（额度墙＝29），若有。 */
  bizCode?: number;
  /** quotas[i].reset_at（秒级 UNIX float，上游原值，未换算成毫秒）。 */
  resetAtSeconds?: number;
  /** 耗尽条目文案（quotas[i].msg，常含「将于 … 恢复」）。 */
  quotaMsg?: string;
  /** 上游 alert 可读文本（title/description/buttons 拼接，非硬编码）。 */
  alertText?: string;
}

/**
 * 人机验证挑战（40303 CHALLENGE_REQUIRED，㊿-c-补⑩）元数据。上游（数美 shumei 等）
 * 在 200 外壳里回 code:40303 + data{provider, challenge_id, extras.expected_mode}，
 * 要求完成一次人机验证（spatial_select 点选式等）。**确定性、不可重试**——重发同一
 * 请求必再撞同一挑战（与额度墙同性质）。本结构是挑战识别与文案组合的唯一真源。
 */
export interface ChallengeInfo {
  /** 挑战提供方（data.provider，如 'shumei'），若有。 */
  provider?: string;
  /** 挑战 id（data.challenge_id），若有。 */
  challengeId?: string;
  /** 期望的验证方式（data.extras.expected_mode，如 'spatial_select'），若有。 */
  expectedMode?: string;
}

export interface ClassifiedResponse {
  verdict: ResponseVerdict;
  status: number;
  reason: string;
  /** 429 Retry-After 建议（毫秒），无则 undefined。 */
  retryAfterMs?: number;
  /** 额度墙元数据（verdict === 'quota-exhausted' 时携带）。 */
  quota?: QuotaWallInfo;
  /** 人机验证挑战元数据（verdict === 'challenge-required' 时携带）。 */
  challenge?: ChallengeInfo;
}

/**
 * 载荷级错误分类的**唯一真源**（R4.5-N2）。
 *
 * 之前 HTTP 侧（parseBodyError）与 SSE 侧（classifySseFrame）各写了一套，
 * 两者对同一个 `code=0` 的判定**相反**：
 *   - HTTP 侧：`code === 0 && !err` → 不算错（DeepSeek 的正常成功包也带 code/status: 0）；
 *   - SSE 侧：`code === 0` 且带 error/message → 判 **fatal**。
 * 结果：同样的载荷，走 HTTP 是可重试、走 SSE 却 fatal —— 与上游语义冲突，
 * 表现为「流里报了个 0 就直接放弃本轮」。
 *
 * 现在两条路径共用本函数，语义一致：
 *   - 单独 `code:0`（无 error/message）→ **不算错**（正常成功包也带 code:0）；
 *   - `code:0` 且带 error/message → 可重试（与 HTTP 侧 body-error 同口径）；
 *   - 401/403/402 → 不可重试（鉴权/计费）；
 *   - 429/500 → 可重试；其余带 error 的 code → 可重试。
 *
 * @param code 载荷里的 code/status（数字）；无则 undefined
 * @param errText 载荷里的 error/message 文本；无则空串
 * @param reasonPrefix 错误原因前缀（'body-error' / 'sse-error-payload'）
 */
export function classifyErrorPayload(
  code: number | undefined,
  errText: string,
  reasonPrefix: string,
): { retryable: boolean; reason: string } | null {
  const hasErr = errText.trim().length > 0;
  if (code === undefined && !hasErr) return null;
  // DeepSeek 的正常成功包也会带 code/status: 0。单独 code:0 且没有明确错误信息时
  // **绝不能**误报为上游失败（HTTP 侧一直这么判，SSE 侧此前不一致）。
  if (code === 0 && !hasErr) return null;
  // 401/403/402 等鉴权/计费错误即使包在 200 里也是 fatal（不可重试）。
  if (code === 401 || code === 403 || code === 402) {
    return { retryable: false, reason: `${reasonPrefix}-${code}` };
  }
  // 429 限流与 5xx、以及其余带错误信息的载荷 → 可重试。
  return { retryable: true, reason: `${reasonPrefix}-${code ?? 'unknown'}` };
}

/** 解析 200 响应体里的错误载荷（DeepSeek 偶发在 200 内回 status=0 / error.message）。 */
function parseBodyError(bodyText: string | null): { retryable: boolean; reason: string } | null {
  if (!bodyText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    const trimmed = bodyText.trimStart();
    // SSE has its own frame classifier; scanning the whole successful stream for
    // error-looking prose would misclassify a normal answer that happens to mention it.
    if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) return null;
    const lower = bodyText.toLowerCase();
    const hints = [
      '服务器暂时不可用',
      '服务器不可用',
      '服务繁忙',
      '请稍后重试',
      'rate limit',
      'too many requests',
      'overloaded',
      'temporarily unavailable',
      'service unavailable',
    ];
    if (hints.some((hint) => lower.includes(hint))) {
      return { retryable: true, reason: 'plain-text-upstream-busy' };
    }
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const code = typeof o.code === 'number' ? o.code : typeof o.status === 'number' ? o.status : undefined;
  const errText = extractErrorText(o.error) || extractErrorText(o.message);
  return classifyErrorPayload(code, errText, 'body-error');
}

/**
 * 提取错误文本（兼容两种形态）：
 *   - 字符串：`error: 'boom'` / `message: 'boom'`
 *   - 对象：`error: { message: 'boom' }`（DeepSeek 实际用的是这一种）
 */
function extractErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>).message;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

// ---------------------------------------------------------------- 额度墙（㊿-c①）

/**
 * 额度墙识别（纯函数，唯一真源）。判类靠 `biz_code`（data 层，外层 code:0 把它藏住）＋
 * 存在 `is_exhausted===true` 的 quotas 条目；否则 null（不影响任何既有分类）。
 *
 * ⚠️ 读取层必须逐层下探（㊿-c① 返工，2026-11-20 装版真实 476 B 响应坐实）：`quotas`／`alert`
 * **不一定在 `data` 层**——现场真实形态在 `data.biz_data` 层。故按「data → data.biz_data →
 * 顶层」逐层找**第一个带 `quotas` 数组的层**读 quotas/alert；`biz_code` 仍从 data 层读
 * （已验证，不动）。只判类不逐层取文案 ⇒ 丢恢复时刻＋上游文案（PM 探针实测的退化缺口）。
 * @param parsed 响应体整枚 JSON.parse 结果（外层 `{code:0, data:{...}}`）
 */
export function detectQuotaWall(parsed: unknown): QuotaWallInfo | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  // biz_code 在 data 层（外层 code:0 会把它藏住）；无 data 层时兜底读顶层。
  const data = (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
  const bizCode = typeof data.biz_code === 'number' ? data.biz_code : undefined;
  // quotas／alert 逐层找：data → data.biz_data → 顶层，取第一个带 quotas 数组的层。
  const layers: Record<string, unknown>[] = [data];
  if (data.biz_data && typeof data.biz_data === 'object') {
    layers.push(data.biz_data as Record<string, unknown>);
  }
  if (o !== data) layers.push(o);
  let source: Record<string, unknown> | undefined;
  for (const layer of layers) {
    if (Array.isArray(layer.quotas)) {
      source = layer;
      break;
    }
  }
  source = source ?? data;
  const quotas: unknown[] = Array.isArray(source.quotas) ? (source.quotas as unknown[]) : [];
  const exhausted = quotas.find(
    (q) => q && typeof q === 'object' && (q as Record<string, unknown>).is_exhausted === true,
  ) as Record<string, unknown> | undefined;
  const isWall = !!exhausted || bizCode === 29;
  if (!isWall) return null;
  const info: QuotaWallInfo = {};
  if (bizCode !== undefined) info.bizCode = bizCode;
  if (exhausted) {
    const resetAt = exhausted.reset_at;
    if (typeof resetAt === 'number' && Number.isFinite(resetAt)) info.resetAtSeconds = resetAt;
    if (typeof exhausted.msg === 'string' && exhausted.msg.trim()) info.quotaMsg = exhausted.msg.trim();
  }
  const alertText = extractAlertText(source.alert ?? data.alert ?? o.alert);
  if (alertText) info.alertText = alertText;
  return info;
}

/**
 * 从文本响应体解析额度墙。**仅支持纯 JSON 响应体**（XHR 路径的 `xhr.responseText` 是纯 JSON，
 * 现场撞墙 476 B 形态走这条，不漏）。SSE 前缀形态（`data: {...}`／多帧流）JSON.parse 直接
 * 抛错 ⇒ 返 null ⇒ 判 ok —— 即 fetch 路径若上游把撞墙包塞进 SSE 帧会漏判。**边界说明
 * （2026-11-20 PM 裁定本批不修）：现场是 XHR 路径（`xhr resp[476]`／`no completion sentinel,
 * bytes=476`），不受影响；改 SSE 帧解析风险大于收益，留此注释防后人误判「已全路径覆盖」。
 * 非 JSON 体自然返回 null，不误伤正常流。
 */
function parseQuotaWallFromText(bodyText: string | null): QuotaWallInfo | null {
  if (!bodyText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    return null;
  }
  return detectQuotaWall(obj);
}

/** 提取上游 alert 里的可读文本（title/description/buttons 等），容忍嵌套形态，去重拼接。 */
function extractAlertText(alert: unknown): string | undefined {
  if (!alert || typeof alert !== 'object') return undefined;
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    const t = s.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      parts.push(t);
    }
  };
  const TEXT_KEYS = ['title', 'description', 'msg', 'message', 'label', 'text'];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const it of node) walk(it);
      return;
    }
    if (typeof node === 'object') {
      const ob = node as Record<string, unknown>;
      for (const k of TEXT_KEYS) {
        const v = ob[k];
        if (typeof v === 'string') push(v);
      }
      for (const v of Object.values(ob)) {
        if (v && typeof v === 'object') walk(v);
      }
    }
  };
  walk(alert);
  return parts.length ? parts.join(' ') : undefined;
}

/** 文本是否已含「恢复时刻」（「将于 … 恢复」＋一个钟点）。 */
function textHasRecoveryTime(text: string): boolean {
  return /恢复|recovery/i.test(text) && /\d{1,2}\s*[:：]\s*\d{2}/.test(text);
}

/**
 * 组合额度墙对用户看的文案（纯函数）。三段回退（卡面口径）：
 *  ① 上游文案（quotas.msg ＋ alert）已含恢复时刻 ⇒ 原样透传（不硬编码）；
 *  ② 无恢复时刻但 reset_at 可得 ⇒ 本地时区格式化后明示；
 *  ③ 两者都拿不到 ⇒ 泛化文案。
 */
export function composeQuotaWallMessage(quota?: QuotaWallInfo): string {
  const upstreamParts: string[] = [];
  if (quota?.quotaMsg) upstreamParts.push(quota.quotaMsg);
  if (quota?.alertText) upstreamParts.push(quota.alertText);
  const upstream = upstreamParts.join(' ');
  if (upstream && textHasRecoveryTime(upstream)) return upstream;
  if (quota?.resetAtSeconds) {
    const local = new Date(quota.resetAtSeconds * 1000).toLocaleString();
    return upstream ? `${upstream} 将于 ${local} 恢复。` : `使用额度已用完，将于 ${local} 恢复。`;
  }
  if (upstream) return upstream;
  return '使用额度已用完，请稍后再试。';
}

// ---------------------------------------------------------------- 人机验证挑战（㊿-c-补⑩）

/**
 * 人机验证挑战识别（纯函数，唯一真源）。40303 CHALLENGE_REQUIRED：上游（数美 shumei 等）
 * 在 200 外壳里回 `code:40303`（外层）＋ `data{provider, challenge_id, extras.expected_mode}`。
 * **确定性、不可重试**——重发同一份请求必然再撞同一挑战（与额度墙同性质），正确处置＝
 * 判终局、不烧重试、明示用户需完成人机验证（旧路径把 code:40303 兜底判成「可重试」，
 * 烧掉首轮重试预算后误报「服务器暂时无法访问」，把「需要过验证」伪装成「服务器故障」）。
 *
 * 命中条件（任一）：外层 `code === 40303`；或 `msg === 'CHALLENGE_REQUIRED'`；或任一层有
 * `challenge_id`。读取层逐层下探（data → data.biz_data → 顶层，与 detectQuotaWall 的
 * layers 写法同款），从第一个带 challenge_id 的层读 provider / challenge_id / extras.expected_mode。
 *
 * ⚠️ 挑战识别只走本通道（detectChallengeRequired），**不要**让 extractErrorText 顺手去认
 * `msg` 字段——`msg` 是挑战响应的业务字段，认了会把其他 code:* 响应的 msg 当错误文本，
 * 扩散误判面（卡面裁定）。
 * @param parsed 响应体整枚 JSON.parse 结果（外层 `{code:40303, msg, data:{...}}`）
 */
export function detectChallengeRequired(parsed: unknown): ChallengeInfo | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  // data 层（外层把业务藏住）；无 data 层时兜顶层。
  const data = (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
  // 逐层下探（data → data.biz_data → 顶层，与 detectQuotaWall 同款）。
  const layers: Record<string, unknown>[] = [data];
  if (data.biz_data && typeof data.biz_data === 'object') layers.push(data.biz_data as Record<string, unknown>);
  if (o !== data) layers.push(o);
  const outerCode = typeof o.code === 'number' ? o.code : undefined;
  const msg = typeof o.msg === 'string' ? o.msg : undefined;
  const hit =
    outerCode === 40303 ||
    msg === 'CHALLENGE_REQUIRED' ||
    layers.some((l) => typeof l.challenge_id === 'string' && (l.challenge_id as string).length > 0);
  if (!hit) return null;
  // 逐层取第一个带 challenge_id 的层读 provider / challenge_id / extras.expected_mode。
  let source: Record<string, unknown> | undefined;
  for (const layer of layers) {
    if (typeof layer.challenge_id === 'string') {
      source = layer;
      break;
    }
  }
  source = source ?? data;
  const info: ChallengeInfo = {};
  if (typeof source.provider === 'string') info.provider = source.provider;
  if (typeof source.challenge_id === 'string') info.challengeId = source.challenge_id;
  const extras = source.extras;
  if (extras && typeof extras === 'object' && typeof (extras as Record<string, unknown>).expected_mode === 'string') {
    info.expectedMode = (extras as Record<string, unknown>).expected_mode as string;
  }
  return info;
}

/**
 * 从文本响应体解析人机验证挑战。**仅支持纯 JSON 响应体**（与 parseQuotaWallFromText 同边界：
 * XHR 路径 `xhr.responseText` 是纯 JSON，现场撞挑战的 40303 体走这条）。SSE 前缀 / 非 JSON 体
 * JSON.parse 抛错 ⇒ 返 null ⇒ 不误伤正常流。
 */
function parseChallengeFromText(bodyText: string | null): ChallengeInfo | null {
  if (!bodyText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    return null;
  }
  return detectChallengeRequired(obj);
}

/**
 * 组合人机验证挑战对用户看的文案（纯函数，唯一真源）。明确「需要过验证」、给可行动路径，
 * 不冒充「服务器故障」。expectedMode 缺省时省略括号段（卡面裁定）。
 */
export function composeChallengeMessage(challenge?: ChallengeInfo): string {
  const mode = challenge?.expectedMode;
  const modeClause = mode ? `（当前要求：${mode}）` : '';
  return `需要完成人机验证才能继续。请在浏览器打开 chat.deepseek.com 手动完成一次验证${modeClause}，之后回到 Studio 重新发送本轮消息。`;
}

// ---------------------------------------------------------------- 鉴权失效（㊿-c-补⑪）

/**
 * 鉴权失效（40003 invalid token）识别（纯函数，唯一真源）。上游把本地 token 判无效（同账号多端
 * 互踢／风控）时，回 200 外壳套 `code:40003`＋`msg:"Authorization Failed (invalid token)"`。
 * **确定性、不可重试**——重发同一份请求（带同一枚失效 token）必然再撞同一 40003，与额度墙／
 * 挑战同性质；正确处置＝判终局、不烧重试、明示用户需重新登录（旧路径把它兜底判成「可重试」，
 * 烧掉首轮预算后误报「服务器暂时无法访问」，把「登录态失效」伪装成「服务器故障」）。
 *
 * 命中条件（任一）：外层 `code === 40003`；或 `msg` 含 `invalid token`／`Authorization Failed`
 * 失效语义（大小写不敏感）。与 challenge（40303）不同码、不同处置（重登 vs 过验证），判定排在
 * challenge 之后、parseBodyError 之前（40303 优先级不变）。
 * @param bodyText 200 响应体原文（纯 JSON）
 */
export function parseAuthInvalidFromText(bodyText: string | null): boolean {
  if (!bodyText) return false;
  let obj: unknown;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (o.code === 40003) return true;
  const msg = typeof o.msg === 'string' ? o.msg.toLowerCase() : '';
  return msg.includes('invalid token') || msg.includes('authorization failed');
}

/**
 * 组合鉴权失效对用户看的文案（纯函数，唯一真源）。明确「登录态已失效、需重新登录＋MFA 路径」，
 * 不冒充「服务器故障」。
 */
export function composeAuthInvalidMessage(): string {
  return '登录态已失效（服务端返回 invalid token），请重新登录；若重登要求验证码，请按页面提示完成 MFA 验证。';
}

/**
 * 按 HTTP 状态码 + 响应体分类上游响应。
 * @param status  xhr.status（0 = 断连/网络错误/代理失败）
 * @param bodyText 响应文本（可为 null）
 */
export function classifyResponse(status: number, bodyText: string | null): ClassifiedResponse {
  if (status === 0) return { verdict: 'retryable', status, reason: 'network-error' };
  if (status === 429) {
    return { verdict: 'retryable', status, reason: 'rate-limited', retryAfterMs: parseRetryAfterMs(bodyText) };
  }
  if (status >= 500 && status < 600) return { verdict: 'retryable', status, reason: `server-${status}` };
  if (status === 401 || status === 403 || status === 402) return { verdict: 'fatal', status, reason: `auth-billing-${status}` };
  if (status >= 400) return { verdict: 'fatal', status, reason: `client-${status}` };
  if (status >= 200 && status < 300) {
    // ㊿-c①：额度墙＝200 外壳，data 层 biz_code:29／配额耗尽（外层 code:0 把它藏住）。
    // 必须先于 parseBodyError 判：后者只看 code/error/message，会把「200 ＋ 外层 code:0」
    // 当成功；撞墙流因此无完成哨兵，旧路径再降级成 stream-incomplete 连接中断并自动重试。
    // 命中 ⇒ verdict=quota-exhausted，不可重试。
    const quota = parseQuotaWallFromText(bodyText);
    if (quota) {
      return { verdict: 'quota-exhausted', status, reason: 'quota-exhausted', quota };
    }
    // ㊿-c-补⑩：40303 CHALLENGE_REQUIRED＝200 外壳套确定性人机验证挑战，不可重试（与额度墙
    // 同性质：重发同一请求必再撞同一挑战）。须在 parseBodyError 之前判——后者只看
    // code/error/message，会把 code:40303 兜底判成「可重试」，烧掉首轮重试预算后误报
    // 「服务器暂时无法访问」。
    const challenge = parseChallengeFromText(bodyText);
    if (challenge) {
      return { verdict: 'challenge-required', status, reason: 'challenge-required', challenge };
    }
    // ㊿-c-补⑪：40003 鉴权失效＝200 外壳套 invalid token，不可重试（重发同一失效 token 必再撞）。
    // 判定排在 challenge 之后（40303 优先级不变）、parseBodyError 之前——后者会把 code:40003
    // 兜底判成「可重试」，烧掉首轮预算后误报「服务器暂时无法访问」。
    if (parseAuthInvalidFromText(bodyText)) {
      return { verdict: 'auth-invalid', status, reason: 'auth-invalid' };
    }
    const bodyErr = parseBodyError(bodyText);
    if (bodyErr) {
      return bodyErr.retryable
        ? { verdict: 'retryable', status, reason: bodyErr.reason }
        : { verdict: 'fatal', status, reason: bodyErr.reason };
    }
    return { verdict: 'ok', status, reason: 'success' };
  }
  // 其他状态（3xx 等）保守按 retryable
  return { verdict: 'retryable', status, reason: `unclassified-${status}` };
}

function parseRetryAfterMs(bodyText: string | null): number | undefined {
  if (!bodyText) return undefined;
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    const ra = obj.retryAfter ?? obj.retry_after;
    if (typeof ra === 'number' && ra > 0) return ra * 1000;
  } catch {
    // 非 JSON 忽略
  }
  return undefined;
}

/**
 * R0-R5：SSE 错误帧分类。event=error 或载荷带 status=0/error 即视为异常帧；
 * 正常帧返回 null。供 XHR/fetch hook 在流过程中识别「服务端在流里报错」。
 *
 * R6（2026-11-12 实跑现场）：DeepSeek 的瞬态上游故障以 `event: hint` + `type:error` 下发：
 *   - {type:'error', content:'服务器暂时不可用',   finish_reason:'generation_err'}
 *   - {type:'error', content:'消息发送过于频繁，请稍后重试', finish_reason:'rate_limit_reached'}
 * 这类帧**没有** code/status/error/message 四个字段，旧实现落到
 * classifyErrorPayload(undefined, '') 直接 return null，被当正常帧放行。后果：
 * 空回复（autoReplyLen=0）进 shouldNudge('') 的 nudge 分支 → 烧掉唯一一次 protocol repair →
 * 下一帧同样被忽略 → protocol-repair-failed 硬失败，MAX_ERROR_RETRIES=3 的退避重试
 * 一次都用不上。两者都是瞬态可重试错误，必须交给独立错误预算处理。
 */
export function classifySseFrame(eventType: string | null, parsed: unknown): ClassifiedResponse | null {
  const et = (eventType ?? '').toLowerCase();
  if (et === 'error') {
    return { verdict: 'fatal', status: 200, reason: 'sse-error-frame' };
  }
  if (et === 'hint' && parsed && typeof parsed === 'object') {
    const hint = parsed as Record<string, unknown>;
    const hintType = typeof hint.type === 'string' ? hint.type.toLowerCase() : '';
    const finishReason = typeof hint.finish_reason === 'string' ? hint.finish_reason : '';
    if (hintType === 'error' || finishReason === 'generation_err' || finishReason === 'rate_limit_reached') {
      return {
        verdict: 'retryable',
        status: 200,
        reason: `sse-hint-${finishReason || 'error'}`,
      };
    }
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const code = typeof o.code === 'number' ? o.code : typeof o.status === 'number' ? o.status : undefined;
  const errText = extractErrorText(o.error) || extractErrorText(o.message);
  // R4.5-N2：与 HTTP 侧共用 classifyErrorPayload（同一真源）。
  // 关键差异：此前 SSE 侧把 `code=0` 判 fatal，而 HTTP 侧判「不算错」——
  // 同一个载荷走两条路径结论相反。现在一致：code=0 且带 error/message → 可重试；
  // 单独 code:0（正常成功包也带）→ 不算错。
  const classified = classifyErrorPayload(code, errText, 'sse-error-payload');
  if (!classified) return null;
  return {
    verdict: classified.retryable ? 'retryable' : 'fatal',
    status: 200,
    reason: classified.reason,
  };
}

/**
 * R0-R2：错误重试指数退避（2s → 4s → 8s，封顶 8s + 抖动），取代固定 1.2s 连发。
 * @param attempt 本次是第几次错误重试（从 0 起）
 */
export function errorBackoffMs(attempt: number, jitterMs = 300): number {
  const base = Math.min(2000 * 2 ** Math.max(0, Math.min(attempt, 2)), 8000);
  return base + Math.round(Math.random() * jitterMs);
}

/**
 * R0-R3：重放请求头白名单。auto-continue 复用首次请求头时，只转发协议必需的中性头；
 * 一次性会话令牌（x-hif-leim/x-hif-dliq 等）、Cookie、CSRF 一律剔除，避免复用过期/一次性凭证。
 */
const REPLAYABLE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'user-agent',
  'authorization',
  'lang',
  // 设备 / 客户端标识（PoW 挑战必需）
  'x-device-id',
  'x-device-model',
  'x-client-build',
  'x-client-bundle-id',
  'x-client-platform',
  'x-client-version',
  'x-client-locale',
  'x-client-timezone-offset',
]);

export function filterReplayableHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REPLAYABLE_HEADER_ALLOWLIST.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 错误遥测（R0-R5）

export interface ErrorTrace {
  at: number;
  status: number;
  verdict: ResponseVerdict;
  reason: string;
  attempt: number;
}

const TELEMETRY_CAP = 50;
const ring: ErrorTrace[] = [];

export function recordVerdict(trace: Omit<ErrorTrace, 'at'>): void {
  ring.push({ at: Date.now(), ...trace });
  if (ring.length > TELEMETRY_CAP) ring.shift();
}

export function getErrorTraces(): readonly ErrorTrace[] {
  return [...ring];
}

export function clearErrorTraces(): void {
  ring.length = 0;
}
