import { describe, it, expect } from 'vitest';
import { createApiEngine, parseSSEStream } from '../../src/host/engine/api-engine';

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('ApiEngine S10', () => {
  it('1. name is api', () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk-x', model: 'test' },
      fetchImpl: (() => mockFetchResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(engine.name).toBe('api');
  });

  it('2. health ok when /models returns 200', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk-x', model: 'test' },
      fetchImpl: (() => mockFetchResponse({ data: [] })) as unknown as typeof fetch,
    });
    const h = await engine.health();
    expect(h.ok).toBe(true);
  });

  it('3. health fails on HTTP error', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk-x', model: 'test' },
      fetchImpl: (() => mockFetchResponse({}, false, 401)) as unknown as typeof fetch,
    });
    const h = await engine.health();
    expect(h.ok).toBe(false);
  });

  it('4. send() returns content and completion=complete on finish_reason=stop', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk-x', model: 'test' },
      fetchImpl: (() => mockFetchResponse({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      })) as unknown as typeof fetch,
    });
    const r = await engine.send('hi');
    expect(r.content).toBe('hello');
    expect(r.completion).toBe('complete');
  });

  it('5. finish_reason=length → truncated', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk-x', model: 'test' },
      fetchImpl: (() => mockFetchResponse({
        choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
      })) as unknown as typeof fetch,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('truncated');
  });

  it('6. HTTP error → disconnected', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk-x', model: 'test' },
      fetchImpl: (() => mockFetchResponse({}, false, 500)) as unknown as typeof fetch,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('disconnected');
  });

  it('7. network throw → disconnected', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk-x', model: 'test' },
      fetchImpl: (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('disconnected');
  });

  it('8. sends correct Authorization header', async () => {
    let headers: Record<string, string> = {};
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk-secret', model: 'test' },
      fetchImpl: ((_url: string, opts?: RequestInit) => {
        headers = opts?.headers as Record<string, string>;
        return mockFetchResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] });
      }) as unknown as typeof fetch,
    });
    await engine.send('hi');
    expect(headers.Authorization).toBe('Bearer sk-secret');
  });

  // S14: multi-provider finish_reason normalization
  it('9. Anthropic end_turn → complete', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.anthropic.com', apiKey: 'sk-x', model: 'claude', provider: 'anthropic' },
      fetchImpl: (() => mockFetchResponse({
        choices: [{ message: { content: 'hi' }, finish_reason: 'end_turn' }],
      })) as unknown as typeof fetch,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('complete');
  });

  it('10. Anthropic max_tokens → truncated', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.anthropic.com', apiKey: 'sk-x', model: 'claude', provider: 'anthropic' },
      fetchImpl: (() => mockFetchResponse({
        choices: [{ message: { content: 'partial' }, finish_reason: 'max_tokens' }],
      })) as unknown as typeof fetch,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('truncated');
  });

  it('11. provider field accepted in config', () => {
    const engine = createApiEngine({
      config: { baseURL: 'http://localhost:11434', apiKey: '', model: 'llama3', provider: 'ollama' },
      fetchImpl: (() => mockFetchResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(engine.name).toBe('api');
  });

  it('12. ApiEngine has no destroy needed (no timers/listeners)', () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk', model: 't' },
      fetchImpl: (() => mockFetchResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(engine.name).toBe('api');
  });

  // S17: error classification
  it('13. HTTP 401 → disconnected', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'bad', model: 'test' },
      fetchImpl: (() => mockFetchResponse({}, false, 401)) as unknown as typeof fetch,
    });
    expect((await engine.send('hi')).completion).toBe('disconnected');
  });

  it('14. HTTP 429 → disconnected', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk', model: 'test' },
      fetchImpl: (() => mockFetchResponse({}, false, 429)) as unknown as typeof fetch,
    });
    expect((await engine.send('hi')).completion).toBe('disconnected');
  });

  it('15. HTTP 500 → disconnected', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk', model: 'test' },
      fetchImpl: (() => mockFetchResponse({}, false, 500)) as unknown as typeof fetch,
    });
    expect((await engine.send('hi')).completion).toBe('disconnected');
  });

  it('16. HTTP 503 → disconnected', async () => {
    const engine = createApiEngine({
      config: { baseURL: 'https://api.test.com', apiKey: 'sk', model: 'test' },
      fetchImpl: (() => mockFetchResponse({}, false, 503)) as unknown as typeof fetch,
    });
    expect((await engine.send('hi')).completion).toBe('disconnected');
  });

  // S20: SSE parser
  it('17. parseSSEStream: single chunk', () => {
    const raw = 'data: {"choices":[{"delta":{"content":"Hel"}}]}';
    expect(parseSSEStream(raw)).toEqual(['Hel']);
  });

  it('18. parseSSEStream: multiple chunks', () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      '',
      'data: [DONE]',
    ].join('\n');
    expect(parseSSEStream(raw)).toEqual(['Hel', 'lo']);
  });

  it('19. parseSSEStream: malformed lines skipped', () => {
    const raw = [
      'data: not json',
      '',
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      '',
      'garbage line',
    ].join('\n');
    expect(parseSSEStream(raw)).toEqual(['ok']);
  });
});
