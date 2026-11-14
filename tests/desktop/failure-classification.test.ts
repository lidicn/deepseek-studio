// @vitest-environment node
/**
 * 2026-11-14 真机卡（出资人截图）：**记忆硬闸拦住了写入，提示词却把模型推回去重试**。
 *
 * 现场：同一轮里 `memory_save` 被终局拒绝 6 次（3–37ms 全 `ok=false`），一个字节都没落库，
 * 用户看到刷屏红字＋空转。根因是两条互相打脸的话同时进了 prompt：
 *   - 结构化字段 `retryable: false`（`renderToolResult` 硬编码）；
 *   - 散文 `FAILURE_RECOVERY`：「至少一个工具执行失败…**修正参数**或改用合适的下一步继续」。
 * 对策略性拒绝来说，"修正参数"是**行为指令**：同一调用怎么改都还是同一个策略拒绝。
 *
 * 本文件锁四件事：
 *   ① 终局拒绝 ⇒ prompt **不含**「修正参数」句、含终局句；
 *   ② 真可重试失败（网络/5xx/断流/超时）⇒ 仍含续跑句，且**不**出终局句；
 *   ③ 同一签名被终局拒绝 ≥2 次 ⇒ 出显式计数提示（阈值 2，锁死常量）；
 *   ④ `retryable` 给真值（终局 false / 可重试 true），不许恒 false 或恒 true。
 *
 * 负控（见交卷）：
 *   ① 分性判定退回 `some(!ok)` ⇒ ① 红；
 *   ② `retryable` 改回恒 `false` ⇒ ④ 红。
 */
import { describe, expect, it } from 'vitest';

import {
  REPEAT_DENIAL_ALERT_THRESHOLD,
  TERMINAL_FAILURE_CODES,
  buildContinuationPrompt,
  buildProtocolRepairPrompt,
  classifyToolFailure,
  extractFailureCode,
  type PendingResult,
} from '../../src/shared/continuation-prompt';

const RETRY_PHRASE = '修正参数';
const TERMINAL_PHRASE = '策略性拒绝';

function fail(tool: string, error: string): PendingResult {
  return { invocationName: tool, ok: false, error };
}

/** 取出 `<tool_results>` 那段 JSON 并解析成数组（用于断言 retryable/code 真值）。 */
function parseResults(prompt: string): Array<{
  tool: string;
  ok: boolean;
  detail?: string;
  summary?: string;
  error?: { code?: string; message?: string; retryable?: boolean };
}> {
  const start = prompt.indexOf('<tool_results>') + '<tool_results>'.length;
  const end = prompt.indexOf('</tool_results>');
  return JSON.parse(prompt.slice(start, end).trim()) as Array<{
    tool: string;
    ok: boolean;
    detail?: string;
    summary?: string;
    error?: { code?: string; message?: string; retryable?: boolean };
  }>;
}

describe('① 终局拒绝：不许出现「修正参数继续」', () => {
  it('memory-save-needs-explicit-instruction ⇒ 终局句 + 无续跑句', () => {
    const prompt = buildContinuationPrompt('查客厅设备', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
    ]);
    expect(prompt).toContain(TERMINAL_PHRASE);
    expect(prompt).toContain('重复同一调用不会改变结果');
    expect(prompt).not.toContain(RETRY_PHRASE);
  });

  it('consent-denied / consent-unavailable / workspace-unconfigured / page-not-ready 全部按终局处理', () => {
    for (const code of [
      'consent-denied',
      'consent-unavailable',
      'workspace-unconfigured',
      'page-not-ready',
    ]) {
      const prompt = buildContinuationPrompt('跑一下', [fail('shell.exec', code)]);
      expect(prompt, `${code} 应判终局`).toContain(TERMINAL_PHRASE);
      expect(prompt, `${code} 不该出续跑句`).not.toContain(RETRY_PHRASE);
    }
  });

  it('宿主侧可读文案（码在括号里）也认得出来', () => {
    const hostText =
      '工具 python.exec 需要用户审批，但本次未获批准（用户拒绝或审批等待超时）（consent-denied）。'
      + '请等待用户在审批窗口选择「允许」或「拒绝」；不要重复调用同一工具。';
    const prompt = buildContinuationPrompt('跑 python', [fail('python.exec', hostText)]);
    expect(prompt).toContain(TERMINAL_PHRASE);
    expect(prompt).not.toContain(RETRY_PHRASE);
  });
});

describe('② 真可重试失败：续跑句照旧、不出终局句', () => {
  it('ETIMEDOUT ⇒ 含「修正参数」、不含终局句', () => {
    const prompt = buildContinuationPrompt('拉个接口', [fail('shell.exec', 'ETIMEDOUT')]);
    expect(prompt).toContain(RETRY_PHRASE);
    expect(prompt).not.toContain(TERMINAL_PHRASE);
  });

  it('502 / rate_limit / 断流 ⇒ 都算可重试', () => {
    for (const code of ['HTTP 502 gateway', 'rate_limit_reached', 'SSE stream interrupted']) {
      const prompt = buildContinuationPrompt('拉个接口', [fail('shell.exec', code)]);
      expect(prompt, `${code} 应判可重试`).toContain(RETRY_PHRASE);
      expect(prompt, `${code} 不该出终局句`).not.toContain(TERMINAL_PHRASE);
    }
  });
});

describe('③ 混合批次：两类各出一句，且顺序是终局在前', () => {
  it('终局提示先于续跑提示（先读到的结论定调）', () => {
    const prompt = buildContinuationPrompt('混合任务', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('shell.exec', 'ETIMEDOUT'),
    ]);
    expect(prompt).toContain(TERMINAL_PHRASE);
    expect(prompt).toContain(RETRY_PHRASE);
    expect(prompt.indexOf(TERMINAL_PHRASE)).toBeLessThan(prompt.indexOf(RETRY_PHRASE));
  });
});

describe('④ retryable 真值（不是恒 false，也不是恒 true）', () => {
  it('终局 ⇒ false；可重试 ⇒ true', () => {
    const prompt = buildContinuationPrompt('混合任务', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('shell.exec', 'ETIMEDOUT'),
    ]);
    const results = parseResults(prompt);
    const memory = results.find((r) => r.tool === 'memory.save');
    const shell = results.find((r) => r.tool === 'shell.exec');
    expect(memory?.error?.retryable).toBe(false);
    expect(shell?.error?.retryable).toBe(true);
  });

  it('压缩视图（条数超窗口）同样给真值', () => {
    const execs: PendingResult[] = [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('shell.exec', 'ETIMEDOUT'),
      { invocationName: 'file.read', ok: true, result: 'a' },
      { invocationName: 'file.read', ok: true, result: 'b' },
      { invocationName: 'file.read', ok: true, result: 'c' },
    ];
    const results = parseResults(buildContinuationPrompt('窗口外压缩', execs));
    // 最早两条被压缩（windowed），但 retryable 仍按性质给
    expect(results[0]?.error?.retryable).toBe(false);
    expect(results[1]?.error?.retryable).toBe(true);
  });
});

describe('⑤ 同一签名重复被终局拒绝：显式计数（阈值 2）', () => {
  it('阈值常量锁定为 2（与 UI 的投递封顶对齐口径，别两边各写一个数）', () => {
    expect(REPEAT_DENIAL_ALERT_THRESHOLD).toBe(2);
  });

  it('拒绝 3 次 ⇒ 计数提示含次数、工具名与「停止重试」', () => {
    const prompt = buildContinuationPrompt('查设备', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
    ]);
    expect(prompt).toContain('已被终局拒绝');
    expect(prompt).toContain('3 次');
    expect(prompt).toContain('memory.save ×3');
    expect(prompt).toContain('停止重试');
  });

  it('只拒 1 次 ⇒ 不出计数提示（阈值边界，防"一律提示"）', () => {
    const prompt = buildContinuationPrompt('查设备', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
    ]);
    expect(prompt).not.toContain('已被终局拒绝');
  });

  it('不同工具各拒一次 ⇒ 不凑成重复（按签名分桶）', () => {
    const prompt = buildContinuationPrompt('查设备', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('shell.exec', 'consent-denied'),
    ]);
    expect(prompt).not.toContain('已被终局拒绝');
  });
});

describe('⑥ 协议修复轮同样分性（不新增可重试文案，只补终局/计数）', () => {
  it('终局失败进修复轮 ⇒ 带终局句，且不引入「修正参数」', () => {
    const prompt = buildProtocolRepairPrompt('修个协议', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
    ]);
    expect(prompt).toContain(TERMINAL_PHRASE);
    expect(prompt).not.toContain(RETRY_PHRASE);
  });

  it('可重试失败进修复轮 ⇒ 修复轮文案与改前一致（没有新增失败分性段落）', () => {
    const prompt = buildProtocolRepairPrompt('修个协议', [fail('shell.exec', 'ETIMEDOUT')]);
    expect(prompt).not.toContain(TERMINAL_PHRASE);
    expect(prompt).not.toContain('已被终局拒绝');
  });
});

describe('⑧ 与 UI 折叠回执（duplicate-tool-signature）的边界', () => {
  const FOLDED =
    'duplicate-tool-signature: 同一轮（同流）内已执行过同名同参调用，本枚投递被折叠，结果见前一次。';

  it('折叠回执按终局出文案（不许劝"修正参数继续"）', () => {
    const prompt = buildContinuationPrompt('查设备', [fail('memory.save', FOLDED)]);
    expect(prompt).toContain('策略性拒绝');
    expect(prompt).not.toContain('修正参数');
  });

  it('折叠回执**不计入** N（N 只数"真的执行过、被策略拒绝"的次数）', () => {
    const prompt = buildContinuationPrompt('查设备', [
      fail('memory.save', FOLDED),
      fail('memory.save', FOLDED),
      fail('memory.save', FOLDED),
    ]);
    expect(prompt).not.toContain('已被终局拒绝');
  });

  it('真拒绝 + 折叠回执混在一起：N 只数真拒绝（1 次 ⇒ 不出计数），回执本身仍走终局句', () => {
    const prompt = buildContinuationPrompt('查设备', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('memory.save', FOLDED),
      fail('memory.save', FOLDED),
    ]);
    expect(prompt).toContain('策略性拒绝');
    expect(prompt).not.toContain('已被终局拒绝');
  });
});

describe('⑦ classifyToolFailure 表选（防判定翻转）', () => {
  it('终局集合逐码命中 → terminal', () => {
    for (const code of TERMINAL_FAILURE_CODES) {
      expect(classifyToolFailure({ ok: false, error: code }), code).toBe('terminal');
    }
  });

  it('成功不分类（undefined）；未知码默认可重试（保持旧行为）', () => {
    expect(classifyToolFailure({ ok: true })).toBeUndefined();
    expect(classifyToolFailure({ ok: false, error: 'something-weird' })).toBe('retryable');
  });

  it('文案里既有 timeout 又有终局码 ⇒ 终局优先（不因"timeout"翻转判定）', () => {
    expect(
      classifyToolFailure({ ok: false, error: '审批等待 timeout 超时（consent-denied）' }),
    ).toBe('terminal');
  });
});

// 2026-11-14 PM 复核抓到的真缺陷：原来把**整条错误文本**当"码"用 ⇒ 同一签名只要文案里
// 带了不同参数回显或不同耗时，分桶键就不相等 ⇒ 凑不出 2 ⇒ 计数提示永远不出（现场 6 次被拒
// 也拿不到一句"停止重试"）。以下锁住"抽规范码"。
describe('⑨ 规范码抽取（同一签名、不同全文也要落同一个桶）', () => {
  it('认三种形态：裸码／括号（宿主 describeToolFailure）／前缀（注入层折叠回执）', () => {
    expect(extractFailureCode('memory-save-needs-explicit-instruction')).toBe(
      'memory-save-needs-explicit-instruction',
    );
    expect(extractFailureCode('审批未通过（consent-denied）。请等待用户选择。')).toBe('consent-denied');
    expect(extractFailureCode('duplicate-tool-signature: 同一轮内已执行过同名同参调用')).toBe(
      'duplicate-tool-signature',
    );
  });

  it('抽不出终局码 ⇒ undefined（可重试文案／空串／undefined 都不许瞎猜）', () => {
    expect(extractFailureCode('ETIMEDOUT')).toBeUndefined();
    expect(extractFailureCode('')).toBeUndefined();
    expect(extractFailureCode(undefined)).toBeUndefined();
  });

  it('多个码同现 ⇒ 取出现最靠前那个（前缀形态优先，判定不随出现顺序翻转）', () => {
    expect(extractFailureCode('consent-denied: 句尾才提到（page-not-ready）')).toBe('consent-denied');
  });

  it('同一调用、同一码、全文不同（参数回显＋耗时不同）⇒ 仍然凑成 N=3', () => {
    const prompt = buildContinuationPrompt('存记忆', [
      fail('memory.save', 'memory-save-needs-explicit-instruction: 用户没明确要求（params={"k":"a"}，3ms）'),
      fail('memory.save', '（memory-save-needs-explicit-instruction）请先让用户明确要求（params={"k":"b"}，37ms）'),
      fail('memory.save', 'memory-save-needs-explicit-instruction: 又一次（params={"k":"c"}，12ms）'),
    ]);
    expect(prompt).toContain('已被终局拒绝 3 次');
    expect(prompt).toContain('memory.save ×3');
    // 提示里印**码**，不印那 120 字句子：长句会淹掉"停止重试"这句指令。
    expect(prompt).toContain('（原因：memory-save-needs-explicit-instruction）');
    const noticeLine = prompt.split('\n').find((l) => l.includes('已被终局拒绝')) ?? '';
    expect(noticeLine).not.toContain('params=');
    expect(noticeLine).not.toContain('37ms');
  });

  it('同一码但工具不同 ⇒ 不凑成重复（键＝tool+code，不是 code）', () => {
    const prompt = buildContinuationPrompt('两件事', [
      fail('memory.save', 'consent-denied'),
      fail('python.exec', 'consent-denied'),
    ]);
    expect(prompt).not.toContain('已被终局拒绝');
  });

  // ⚠️ **已知边界**（PM 2026-11-14 裁定：**不收紧**，但必须锁成显式契约，不能等人踩）。
  //
  // `extractFailureCode` 用 `indexOf` 裸子串匹配，所以注释里说的"三种形态"（裸码／括号／前缀）
  // 实际上归一到同一种匹配：**工具输出正文里只要出现过 `hard-deny` 这类字样，整条失败就会被
  // 判终局**。方向上是安全的（宁可少重试一次，不是多烧一轮），所以维持现状。
  //
  // 后续判据（真出现误报时再收紧）：**只认开头（`code:`）或 `（）/[]` 内的码**，
  // 并同步宿主 `page-runtime.describeToolFailure` 的括号位置——那是同一批改动，不许只改一侧。
  //
  // 同款边界：**取最靠前命中**⇒ 先出现的是"正文引用"时会盖掉后面真正的码，
  // 提示里印的会是前者。两枚都锁在这里。
  it('已知边界：正文引用码字样 ⇒ 判终局；先出现的别的码会盖掉真码（锁现状，不是认可）', () => {
    // ① 正文引用：真实失败原因是"连接被重置"，但输出里引用了 `hard-deny` 这个词 ⇒ 现状判终局
    const cited = 'stdout: 文档里写着 hard-deny 这个词的描述（真实失败原因：连接被重置）';
    expect(extractFailureCode(cited)).toBe('hard-deny');
    expect(classifyToolFailure({ ok: false, error: cited })).toBe('terminal');

    // ② 最靠前命中优先：正文先引用 `page-not-ready`，真正的码在后面的括号里 ⇒ 抽到的是前者
    const masked = 'page-not-ready 只是正文引用；真正原因是（consent-denied）';
    expect(extractFailureCode(masked)).toBe('page-not-ready');
    const prompt = buildContinuationPrompt('查设备', [
      fail('browser.exec', masked),
      fail('browser.exec', masked),
    ]);
    expect(prompt).toContain('browser.exec ×2（原因：page-not-ready）');
  });
});

describe('⑩ 结构化 error.code 与散文同源（两个视图都填）', () => {
  it('宿主括号文案 ⇒ 码填进 error.code，retryable=false', () => {
    const hostText =
      '工具 python.exec 需要用户审批，但本次未获批准（consent-denied）。不要重复调用同一工具。';
    const results = parseResults(buildContinuationPrompt('跑 python', [fail('python.exec', hostText)]));
    expect(results[0]?.error?.code).toBe('consent-denied');
    expect(results[0]?.error?.retryable).toBe(false);
  });

  it('可重试失败不带码（code 缺省，不是空串）', () => {
    const results = parseResults(buildContinuationPrompt('拉接口', [fail('shell.exec', 'ETIMEDOUT')]));
    expect(results[0]?.error?.code).toBeUndefined();
    expect(results[0]?.error?.retryable).toBe(true);
  });

  it('压缩视图同样带码，且压缩后的重复仍能凑成 N（分桶不依渲染视图）', () => {
    const execs: PendingResult[] = [
      fail('memory.save', '（consent-denied）'),
      fail('memory.save', 'consent-denied: 第二次（params 不同）'),
      { invocationName: 'file.read', ok: true, result: 'a' },
      { invocationName: 'file.read', ok: true, result: 'b' },
      { invocationName: 'file.read', ok: true, result: 'c' },
    ];
    const prompt = buildContinuationPrompt('窗口外压缩', execs);
    const results = parseResults(prompt);
    expect(results[0]?.error?.code).toBe('consent-denied');
    expect(results[1]?.error?.code).toBe('consent-denied');
    expect(prompt).toContain('已被终局拒绝 2 次');
  });
});

// 64KB 单轮预算 + 4000 字 detail 截断是**唯一会吞掉失败文案的路径**（PM 复核点名）。
// 判定与分桶都走原始 `PendingResult.error`，不读渲染后的文本——下面把这一点锁死。
describe('⑪ 截断／64KB 预算锁：文案被吞后判定与分桶仍成立', () => {
  const LONG_PAD = 'x'.repeat(6000);

  it('终局码落在 detail 截断点之后 ⇒ 渲染面无码，仍判终局、仍计数、码仍进结构化字段', () => {
    const tail = `${LONG_PAD}（consent-denied）`;
    const prompt = buildContinuationPrompt('跑 python', [
      fail('python.exec', tail),
      fail('python.exec', tail),
    ]);
    expect(prompt).toContain(TERMINAL_PHRASE);
    expect(prompt).toContain('已被终局拒绝 2 次');
    expect(prompt).toContain('python.exec ×2（原因：consent-denied）');
    const results = parseResults(prompt);
    expect(results[0]?.detail).toContain('...[truncated]');
    expect(results[0]?.detail).not.toContain('consent-denied'); // 渲染面已被吞掉
    expect(results[0]?.error?.code).toBe('consent-denied'); // 判定面仍拿得到
    expect(results[0]?.error?.retryable).toBe(false);
  });

  it('结果累计超 64KB 被压缩／省略后，终局句与计数提示仍在', () => {
    const big = 'y'.repeat(30 * 1024);
    const execs: PendingResult[] = [
      fail('memory.save', `consent-denied: ${big}`),
      fail('memory.save', `consent-denied: ${big}`),
      fail('memory.save', `consent-denied: ${big}`),
    ];
    const prompt = buildContinuationPrompt('存记忆', execs);
    expect(prompt).toContain('超过 64 KB 预算'); // 预算确实生效（否则这条锁是空转）
    expect(prompt).toContain(TERMINAL_PHRASE);
    expect(prompt).toContain('已被终局拒绝 3 次');
  });
});
