import { describe, expect, it } from 'vitest';
import { createToolCallDedupe } from '../../src/shared/tool-call-dedupe';

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
