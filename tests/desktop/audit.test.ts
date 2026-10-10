import { describe, expect, it } from 'vitest';
import {
  createAuditLog,
  DEFAULT_AUDIT_CAPACITY,
  isDenyOutcome,
  summarizeParams,
  SUMMARY_MAX_LEN,
} from '../../src/host/audit';

const base = { tool: 'echo', origin: 'https://chat.deepseek.com' } as const;

describe('host/audit —— 环形缓冲与终态覆盖', () => {
  it('写入后可按时间顺序读出，latest 在末尾', () => {
    const log = createAuditLog(10);
    log.record({ ...base, outcome: 'executed' });
    log.record({ ...base, outcome: 'denied', reason: 'expired' });
    const all = log.list();
    expect(all).toHaveLength(2);
    expect(all[0].outcome).toBe('executed');
    expect(all[1].outcome).toBe('denied');
    expect(all[1].reason).toBe('expired');
    // ok 字段由 outcome 推导，不允许调用方自定义，避免出现「denied 但 ok=true」的假记录
    expect(all[0].ok).toBe(true);
    expect(all[1].ok).toBe(false);
  });

  it('容量写满后丢弃最旧记录，但 total 仍累计（可发现审计被覆盖）', () => {
    const log = createAuditLog(3);
    for (let i = 0; i < 5; i++) log.record({ ...base, tool: `t${i}`, outcome: 'executed' });
    const all = log.list();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.tool)).toEqual(['t2', 't3', 't4']);
    expect(log.total).toBe(5);
  });

  it('默认容量为 200 且正整校验生效', () => {
    const log = createAuditLog();
    for (let i = 0; i < 250; i++) log.record({ ...base, outcome: 'executed' });
    expect(log.list()).toHaveLength(DEFAULT_AUDIT_CAPACITY);
    expect(() => createAuditLog(0)).toThrow(RangeError);
    expect(() => createAuditLog(-1)).toThrow(RangeError);
  });

  it('每条记录带唯一 id 与时间戳', () => {
    const log = createAuditLog(10);
    const a = log.record({ ...base, outcome: 'executed' });
    const b = log.record({ ...base, outcome: 'executed' });
    expect(a.id).not.toBe(b.id);
    expect(a.at).toBeGreaterThan(0);
    expect(b.at).toBeGreaterThanOrEqual(a.at);
  });

  it('listByTool / listDenied 过滤正确', () => {
    const log = createAuditLog(20);
    log.record({ ...base, tool: 'shell.exec', outcome: 'policy-denied' });
    log.record({ ...base, tool: 'echo', outcome: 'executed' });
    log.record({ ...base, tool: 'shell.exec', outcome: 'executed' });
    expect(log.listByTool('shell.exec')).toHaveLength(2);
    expect(log.listByTool('echo')).toHaveLength(1);
    const denied = log.listDenied();
    expect(denied).toHaveLength(1);
    expect(denied[0].tool).toBe('shell.exec');
  });

  it('拒绝类终态集合覆盖全部 deny 出口，执行失败不算 deny', () => {
    // 这条断言的价值：新增 AuditOutcome 时若忘记归入 DENY_OUTCOMES，此处即红。
    expect(isDenyOutcome('malformed')).toBe(true);
    expect(isDenyOutcome('denied')).toBe(true);
    expect(isDenyOutcome('unknown-capability')).toBe(true);
    expect(isDenyOutcome('origin-denied')).toBe(true);
    expect(isDenyOutcome('consent-unavailable')).toBe(true);
    expect(isDenyOutcome('consent-denied')).toBe(true);
    expect(isDenyOutcome('policy-denied')).toBe(true);
    expect(isDenyOutcome('execution-failed')).toBe(false);
    expect(isDenyOutcome('executed')).toBe(false);
  });
});

describe('host/audit —— summarizeParams 摘要', () => {
  it('shell 取 command 字段', () => {
    expect(summarizeParams({ command: 'npm test' }, 'shell.exec')).toBe('npm test');
  });

  it('file 类取 path 字段', () => {
    expect(summarizeParams({ path: 'C:/repo/a.txt', encoding: 'utf8' }, 'file.read')).toBe('C:/repo/a.txt');
  });

  it('其它工具退化为 JSON', () => {
    expect(summarizeParams({ text: 'hi' }, 'chat-insert')).toContain('hi');
  });

  it('超长内容被截断，避免命令本身撑爆审计', () => {
    const long = 'x'.repeat(SUMMARY_MAX_LEN + 500);
    const s = summarizeParams({ command: long }, 'shell.exec');
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_LEN + 1);
    expect(s.endsWith('…')).toBe(true);
  });

  it('参数为空或异常时不抛错，且给出可读占位（审计自身不能成为故障源）', () => {
    expect(summarizeParams(null, 'shell.exec')).toBe('(empty)');
    expect(summarizeParams(undefined)).toBe('(empty)');
    expect(summarizeParams({}, 'file.write')).toBe('{}');
  });
});
