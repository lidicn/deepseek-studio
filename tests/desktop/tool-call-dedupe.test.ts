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
