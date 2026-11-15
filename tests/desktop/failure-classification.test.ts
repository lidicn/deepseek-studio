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
  NON_TERMINAL_FUSE_THRESHOLD,
  REPEAT_DENIAL_ALERT_THRESHOLD,
  SELF_HEALING_FAILURE_CODES,
  TERMINAL_FAILURE_CODES,
  TERMINAL_FUSE_THRESHOLD,
  buildContinuationPrompt,
  buildProtocolRepairPrompt,
  classifyToolFailure,
  evaluateTerminalFuse,
  extractFailureCode,
  extractSelfHealingCode,
  type PendingResult,
} from '../../src/shared/continuation-prompt';
import { shouldSkipAutoContinue } from '../../src/shared/tool-result-format';

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

  it('consent-denied / consent-unavailable / workspace-unconfigured 全部按终局处理', () => {
    // 2026-11-15 对齐：`page-not-ready` 已按 PM 裁定移出终局族（连接级无页会自愈，
    // 判终局会让整批 terminate ⇒ 那一轮零可见交代），对应的反证锁在 ⑫。
    for (const code of [
      'consent-denied',
      'consent-unavailable',
      'workspace-unconfigured',
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

    // ② 最靠前命中优先：正文先引用 `unknown-tool`，真正的码在后面的括号里 ⇒ 抽到的是前者
    //    （2026-11-15：原用例用 `page-not-ready` 作"正文引用"，它被移出终局族后不再可抽，改用仍在表内的码）
    const masked = 'unknown-tool 只是正文引用；真正原因是（consent-denied）';
    expect(extractFailureCode(masked)).toBe('unknown-tool');
    const prompt = buildContinuationPrompt('查设备', [
      fail('browser.exec', masked),
      fail('browser.exec', masked),
    ]);
    expect(prompt).toContain('browser.exec ×2（原因：unknown-tool）');
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
// 2026-11-15 卡⑨：真机一个 turn 内 `memory_save` 被拒 **135 次**、AutoForge 一次没被调用。
// 135 枚里有 **129 种不同 params** ⇒ 按 (name, params) 全等的折叠被换 payload 直接绕开，
// 唯一模型改不动的键是**失败码**。熔断按 (tool, 规范失败码) 计数，阈值 3。
// 2026-11-15 卡⑨-c：自愈码（环境状态相关）既不能进终局族（⑨-补2），也不能吃
// FAILURE_RECOVERY 那句"修正参数或改用合适的下一步"——参数改了没用，不变的是环境。
// 这是 135 连拒的镜像病灶：字段说"等环境就绪"、散文说"改参数"，模型执行散文。
describe('⑬ 自愈码：不吃「修正参数」句，改挂自愈文案', () => {
  /** FAILURE_RECOVERY 的行为指令原文（锁它的整句，不锁两个字——自愈文案里也有"修正参数不会改变结果"）。 */
  const RECOVERY_CMD = '修正参数或改用合适的下一步继续完成任务';
  const SELF_HEALING_PHRASE = '与环境状态有关';

  it('no-page-for-dom-capability ⇒ 自愈文案 ＋ 无续跑指令句', () => {
    const prompt = buildContinuationPrompt('查设备', [fail('chat-read', 'no-page-for-dom-capability')]);
    expect(prompt).toContain(SELF_HEALING_PHRASE);
    expect(prompt).toContain('等环境就绪后重试才可能成功');
    expect(prompt).toContain('不要原样重试同一调用');
    expect(prompt).not.toContain(RECOVERY_CMD);
    // 也不许被终局文案吃掉（它不是策略拒绝）
    expect(prompt).not.toContain('策略性拒绝');
  });

  it('三枚自愈码逐个都认（含从未进过码表的 no-page-runtime）', () => {
    for (const code of SELF_HEALING_FAILURE_CODES) {
      expect(extractSelfHealingCode(code), code).toBe(code);
      const prompt = buildContinuationPrompt('查设备', [fail('chat-read', code)]);
      expect(prompt, code).toContain(SELF_HEALING_PHRASE);
      expect(prompt, code).not.toContain(RECOVERY_CMD);
    }
    expect(SELF_HEALING_FAILURE_CODES).toContain('no-page-runtime');
  });

  it('反证：真可重试失败仍走 FAILURE_RECOVERY，自愈文案不吞它', () => {
    const prompt = buildContinuationPrompt('拉接口', [fail('shell.exec', 'ETIMEDOUT')]);
    expect(prompt).toContain(RECOVERY_CMD);
    expect(prompt).not.toContain(SELF_HEALING_PHRASE);
  });

  it('零交集锁：自愈名单与终局码表不许有共同成员（两表分裂即红）', () => {
    const overlap = SELF_HEALING_FAILURE_CODES.filter((c) => TERMINAL_FAILURE_CODES.includes(c));
    expect(overlap).toEqual([]);
  });

  it('混合批次：终局 > 自愈 > 可重试 三段各自出现且按此顺序', () => {
    const prompt = buildContinuationPrompt('混合任务', [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('chat-read', 'page-not-ready'),
      fail('shell.exec', 'ETIMEDOUT'),
    ]);
    expect(prompt).toContain('策略性拒绝');
    expect(prompt).toContain(SELF_HEALING_PHRASE);
    expect(prompt).toContain(RECOVERY_CMD);
    const iTerminal = prompt.indexOf('策略性拒绝');
    const iSelf = prompt.indexOf(SELF_HEALING_PHRASE);
    const iRetry = prompt.indexOf(RECOVERY_CMD);
    expect(iTerminal).toBeLessThan(iSelf);
    expect(iSelf).toBeLessThan(iRetry);
  });

  it('协议修复轮同样挂自愈文案（修复轮最容易"换个写法再试"）', () => {
    const prompt = buildProtocolRepairPrompt('修协议', [fail('chat-read', 'no-page-runtime')]);
    expect(prompt).toContain(SELF_HEALING_PHRASE);
    expect(prompt).not.toContain(RECOVERY_CMD);
  });
});

describe('⑫ 终局熔断（阈值 3，按 (tool, 失败码) 而非 (tool, params)）', () => {
  it('阈值常量锁定为 3，且与另两个阈值不在同一根轴（注释里互相点名）', () => {
    expect(TERMINAL_FUSE_THRESHOLD).toBe(3);
    // 三根轴：注入层同签名封顶 3（一条流）／提示阈值 2（一个 turn）／熔断阈值 3（一个 turn，强制停）
    expect(TERMINAL_FUSE_THRESHOLD).toBeGreaterThan(REPEAT_DENIAL_ALERT_THRESHOLD);
  });

  it('同一 (tool, 码) 拒 3 次 ⇒ fuse:true 且点名 tool/code/count', () => {
    const verdict = evaluateTerminalFuse([
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
    ]);
    expect(verdict).toEqual({
      fuse: true,
      axis: 'terminal',
      tool: 'memory.save',
      code: 'memory-save-needs-explicit-instruction',
      count: 3,
    });
  });

  it('拒 2 次 ⇒ 不熔断（提示阈值先到、熔断多留一次余量，防误杀"正好改好参数"）', () => {
    const execs = [
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
    ];
    expect(evaluateTerminalFuse(execs).fuse).toBe(false);
    // 同一个输入在提示那根轴上已经触发：证明两根轴独立
    expect(buildContinuationPrompt('存记忆', execs)).toContain('已被终局拒绝 2 次');
  });

  it('换 payload（129 种不同 params 那种形态）绕不开熔断：码相同即同一桶', () => {
    const verdict = evaluateTerminalFuse([
      fail('memory.save', 'memory-save-needs-explicit-instruction: 第一次（params={"name":"用户","content":"用户"}）'),
      fail('memory.save', '（memory-save-needs-explicit-instruction）第二次（params={"name":"客厅","content":"设备"}）'),
      fail('memory.save', 'memory-save-needs-explicit-instruction: 第三次（params={"tags":["u"]}）'),
    ]);
    expect(verdict.fuse).toBe(true);
    expect(verdict.count).toBe(3);
    expect(verdict.code).toBe('memory-save-needs-explicit-instruction');
  });

  it('不同码各 2 次 ⇒ 不凑成熔断（桶键含码，不按工具合并）', () => {
    const verdict = evaluateTerminalFuse([
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('memory.save', 'memory-save-needs-explicit-instruction'),
      fail('memory.save', 'memory-save-task-snapshot'),
      fail('memory.save', 'memory-save-task-snapshot'),
    ]);
    expect(verdict.fuse).toBe(false);
  });

  it('折叠回执不计入熔断（与阈值 2 那侧同一口径，两个 N 不能各数一套）', () => {
    const folded =
      'duplicate-tool-signature: 同一轮（同流）内已执行过同名同参调用，本枚投递被折叠，结果见前一次。';
    const verdict = evaluateTerminalFuse([
      fail('memory.save', folded),
      fail('memory.save', folded),
      fail('memory.save', folded),
    ]);
    expect(verdict.fuse).toBe(false);
  });

  it('可重试类失败的 3 枚不熔（通用轴阈值是 5；低于它只是"还没到刷屏止损线"）', () => {
    const verdict = evaluateTerminalFuse([
      fail('shell.exec', 'ETIMEDOUT'),
      fail('shell.exec', 'ETIMEDOUT'),
      fail('shell.exec', 'HTTP 502 gateway'),
    ]);
    expect(verdict.fuse).toBe(false);
  });

  it('通用轴按归一化失败键分桶：不同首行不凑数，同一首行（带不同后续行）算同一桶', () => {
    const same = (extra: string) => fail('shell.exec', `ETIMEDOUT${extra}`);
    // 首行相同、后续行（参数回显）不同 ⇒ 同一个桶 ⇒ 5 枚熔
    const fused = evaluateTerminalFuse([
      same('\nparams={"t":1}'),
      same('\nparams={"t":2}'),
      same('\nparams={"t":3}'),
      same('\nparams={"t":4}'),
      same('\nparams={"t":5}'),
    ]);
    expect(fused).toMatchObject({ fuse: true, axis: 'non-terminal', tool: 'shell.exec', count: 5 });
    // 首行不同 ⇒ 各自 3 枚，谁都没到 5 ⇒ 不熔
    expect(evaluateTerminalFuse([
      fail('shell.exec', 'ETIMEDOUT'),
      fail('shell.exec', 'ETIMEDOUT'),
      fail('shell.exec', 'ETIMEDOUT'),
      fail('shell.exec', 'HTTP 502 gateway'),
      fail('shell.exec', 'HTTP 502 gateway'),
      fail('shell.exec', 'HTTP 502 gateway'),
    ]).fuse).toBe(false);
  });

  it('三个"无页／可能自愈"码一律不进终局族（2026-11-15 裁定，含反证锁）', () => {
    // 判据是"重试必然同果"，不是"听起来像错误"：页端连上/刷新/导航后这三个码都会变可用。
    // 标成终局 ⇒ 宿主发 terminate ⇒ shouldSkipAutoContinue（every 语义）整批跳过续跑
    // ⇒ 那一轮**没有任何模型文本交代**，撞出资人 11-11 拍的"必须给可见提示"判据。
    for (const code of ['page-not-ready', 'no-page-for-dom-capability', 'no-page-runtime']) {
      expect(TERMINAL_FAILURE_CODES, code).not.toContain(code);
      expect(extractFailureCode(code), code).toBeUndefined();
      expect(classifyToolFailure({ ok: false, error: code }), code).toBe('retryable');
    }
    // `no-capability`：出口保留为防御性 fail-closed，但**码同样摘出**（当前不可达，
    // 留着会让下一个人当成真会发生的终局）。两表若分裂需回表＋补行为锁。
    expect(TERMINAL_FAILURE_CODES).not.toContain('no-capability');
    expect(classifyToolFailure({ ok: false, error: 'no-capability' })).toBe('retryable');

    // 终局轴仍然认真正的"同果"码：unknown-capability 3 枚即熔
    const verdict = evaluateTerminalFuse([
      fail('chat-read', 'unknown-capability'),
      fail('chat-read', 'unknown-capability'),
      fail('chat-read', 'unknown-capability'),
    ]);
    expect(verdict).toMatchObject({ fuse: true, axis: 'terminal', tool: 'chat-read', code: 'unknown-capability', count: 3 });
  });

  it('连接级无页**不得把该轮锁进"零可见交代"**：整批无页不带 terminate ⇒ 续跑不被跳过', () => {
    // 行为锁（不是我域的文案锁）：宿主对这三个码不再挂 terminate，
    // 于是 shouldSkipAutoContinue 的 every 判定为 false ⇒ 模型还有机会给用户一句交代。
    const batch = [
      fail('chat-read', 'page-not-ready'),
      fail('chat-send', 'no-page-for-dom-capability'),
      fail('shell.exec', 'no-page-runtime'),
    ];
    // ① 宿主出口形态：这些结果不带 terminate（等价于全部 undefined）
    const asHostWouldEmit = batch.map((e) => ({ ...e, terminate: undefined }));
    // ② 分类面：三条都必须落非终局——这一句才是"码表对齐"的真牙齿（把任一条加回表 ⇒ 红）
    expect(batch.every((e) => classifyToolFailure(e) !== 'terminal')).toBe(true);
    expect(shouldSkipAutoContinue(asHostWouldEmit)).toBe(false);
    // ② 熔断也不在 3 枚时触发（要走通用轴的 5）
    expect(evaluateTerminalFuse(batch).fuse).toBe(false);
    // ③ 反面对照：整批真终局（exit 不可用）仍然允许跳过续跑——every 语义没被放松
    expect(shouldSkipAutoContinue([
      { terminate: true },
      { terminate: true },
    ])).toBe(true);
    expect(shouldSkipAutoContinue([{ terminate: true }, { terminate: undefined }])).toBe(false);
  });

  it('通用熔断轴：非终局的同一失败键达 5 枚才熔，4 枚不熔（与终局阈值 3 各自独立）', () => {
    const page = (n: number): PendingResult[] =>
      Array.from({ length: n }, () => fail('chat-read', 'no-page-for-dom-capability'));
    expect(evaluateTerminalFuse(page(4)).fuse).toBe(false);
    expect(evaluateTerminalFuse(page(5))).toMatchObject({
      fuse: true,
      axis: 'non-terminal',
      tool: 'chat-read',
      count: 5,
    });
    // 同一条数轴上的语义区分：终局 3 枚熔（重试无意义），非终局 3 枚**不熔**（可能自愈）
    expect(evaluateTerminalFuse([
      fail('chat-read', 'unknown-capability'),
      fail('chat-read', 'unknown-capability'),
      fail('chat-read', 'unknown-capability'),
    ]).axis).toBe('terminal');
    expect(evaluateTerminalFuse(page(3)).fuse).toBe(false);
    expect(NON_TERMINAL_FUSE_THRESHOLD).toBe(5);
  });

  it('接线：生产形态（terminate 在顶层、result 里不含）不影响熔断判定', () => {
    // 真机形态：宿主返回 `result:{content:[…],isError:true}`，`terminate` 是**同级**字段。
    const productionShape: PendingResult[] = [
      {
        invocationName: 'memory.save',
        ok: false,
        error: 'memory-save-needs-explicit-instruction',
        result: { content: [{ type: 'text', text: '未写入记忆' }], isError: true },
        terminate: true,
      },
      {
        invocationName: 'memory.save',
        ok: false,
        error: 'memory-save-needs-explicit-instruction',
        result: { content: [{ type: 'text', text: '未写入记忆' }], isError: true },
        terminate: true,
      },
      {
        invocationName: 'memory.save',
        ok: false,
        error: 'memory-save-needs-explicit-instruction',
        result: { content: [{ type: 'text', text: '未写入记忆' }], isError: true },
        terminate: true,
      },
    ];
    // result 里没有 terminate（**不许**把判据建在 payload 内）
    expect(productionShape.every((p) => !('terminate' in (p.result as Record<string, unknown>)))).toBe(true);
    expect(evaluateTerminalFuse(productionShape).fuse).toBe(true);
    expect(classifyToolFailure(productionShape[0])).toBe('terminal');
    // 没有 terminate 字段（旧宿主）同样能判熔断：熔断不依赖宿主是否已升级
    expect(evaluateTerminalFuse(productionShape.map(({ terminate: _t, ...rest }) => rest)).fuse).toBe(true);
  });
});

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
