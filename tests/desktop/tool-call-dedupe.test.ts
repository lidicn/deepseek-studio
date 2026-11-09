import { describe, expect, it } from 'vitest';
import { createToolCallDedupe } from '../../src/shared/tool-call-dedupe';
import { StreamingToolCallParser } from '../../src/inject/streaming-tool-parser';
import { MATCHABLE_INVOCATION_NAMES } from '../../src/shared/tool-contract';

describe('QD-R8 tool call dedupe', () => {
  it('claims the same callId only once until reset', () => {
    const dedupe = createToolCallDedupe();
    expect(dedupe.claim('call-1')).toBe(true);
    expect(dedupe.claim('call-1')).toBe(false);
    expect(dedupe.has('call-1')).toBe(true);
    expect(dedupe.size()).toBe(1);

    dedupe.reset();
    expect(dedupe.has('call-1')).toBe(false);
    expect(dedupe.claim('call-1')).toBe(true);
  });

  it('keeps distinct callIds independent', () => {
    const dedupe = createToolCallDedupe();
    expect(dedupe.claim('call-a')).toBe(true);
    expect(dedupe.claim('call-b')).toBe(true);
    expect(dedupe.size()).toBe(2);
  });
});

describe('QD-R8 tool call signature dedupe', () => {
  it('rejects the same invocation and params with a different callId', () => {
    const dedupe = createToolCallDedupe();
    expect(dedupe.claim('call-a')).toBe(true);
    expect(dedupe.claim('call-b')).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { command: 'ls' })).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { command: 'ls' })).toBe(false);
  });

  it('treats object key order as irrelevant', () => {
    const dedupe = createToolCallDedupe();
    expect(dedupe.claimSignature('shell_exec', { command: 'ls', nested: { b: 2, a: 1 } })).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { nested: { a: 1, b: 2 }, command: 'ls' })).toBe(false);
  });

  it('treats array order as significant', () => {
    const dedupe = createToolCallDedupe();
    expect(dedupe.claimSignature('shell_exec', { args: ['a', 'b'] })).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { args: ['b', 'a'] })).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { args: ['a', 'b'] })).toBe(false);
  });

  it('allows different params', () => {
    const dedupe = createToolCallDedupe();
    expect(dedupe.claimSignature('shell_exec', { command: 'ls' })).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { command: 'pwd' })).toBe(true);
  });

  it('resetSignatures keeps callId claims', () => {
    const dedupe = createToolCallDedupe();
    expect(dedupe.claim('call-1')).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { command: 'ls' })).toBe(true);

    dedupe.resetSignatures();

    expect(dedupe.has('call-1')).toBe(true);
    expect(dedupe.claim('call-1')).toBe(false);
    expect(dedupe.claimSignature('shell_exec', { command: 'ls' })).toBe(true);
  });

  it('reset clears both callId claims and signatures', () => {
    const dedupe = createToolCallDedupe();
    expect(dedupe.claim('call-1')).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { command: 'ls' })).toBe(true);

    dedupe.reset();

    expect(dedupe.has('call-1')).toBe(false);
    expect(dedupe.claim('call-1')).toBe(true);
    expect(dedupe.claimSignature('shell_exec', { command: 'ls' })).toBe(true);
  });
});

describe('T-4 端到端：同参数两拼写只执行一次（验收件跨两席，由 Core 复算）', () => {
  it('mcpcall 与 mcp_call 同参数：去重签名相同，第二次被拦', () => {
    const parser = new StreamingToolCallParser(MATCHABLE_INVOCATION_NAMES);
    const aliasCall = parser.feed('<mcpcall>{"serverId":"TVPilot","tool":"tv_system_state","args":{}}</mcpcall>').calls[0];
    const canonCall = parser.feed('<mcp_call>{"serverId":"TVPilot","tool":"tv_system_state","args":{}}</mcp_call>').calls[0];
    expect(aliasCall.invocationName).toBe('mcp_call');
    expect(canonCall.invocationName).toBe('mcp_call');
    const dedupe = createToolCallDedupe();
    expect(dedupe.claimSignature(aliasCall.invocationName, aliasCall.params)).toBe(true);
    expect(dedupe.claimSignature(canonCall.invocationName, canonCall.params)).toBe(false);
  });
});
