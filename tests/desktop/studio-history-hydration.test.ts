import { describe, expect, it, vi } from 'vitest';
import {
  createHistoryHydrator,
  parseHistoryMessages,
  readDeepSeekAuthToken,
  type HistoryMessage,
} from '../../src/ui/studio-history-hydration';

function message(
  role: string,
  insertedAt: number,
  fragments: Array<{ type: string; content: string }>,
  id: number,
): HistoryMessage {
  return { role, inserted_at: insertedAt, fragments, message_id: id };
}

describe('跨设备历史水合', () => {
  it('只映射 USER/REQUEST 与 ASSISTANT/RESPONSE，跳过 THINK', () => {
    const session = parseHistoryMessages('chat:abc12345', [
      message('USER', 100, [{ type: 'REQUEST', content: '用户问题' }], 1),
      message('ASSISTANT', 101, [
        { type: 'THINK', content: '不应渲染的思考' },
        { type: 'RESPONSE', content: '最终回答' },
      ], 2),
    ], 999);

    expect(session.key).toBe('chat:abc12345');
    expect(session.events).toHaveLength(2);
    expect(session.events[0]).toMatchObject({ type: 'user-message', text: '用户问题' });
    expect(session.events[1]).toMatchObject({ type: 'final-answer', text: '最终回答' });
    expect(session.events.some((event) => event.type === 'tool-start')).toBe(false);
    expect(JSON.stringify(session)).not.toContain('不应渲染的思考');
  });

  it('读取 userToken 的 JSON value，也兼容裸字符串', () => {
    expect(readDeepSeekAuthToken({ getItem: () => '{"value":"token-a"}' })).toBe('token-a');
    expect(readDeepSeekAuthToken({ getItem: () => 'token-b' })).toBe('token-b');
    expect(readDeepSeekAuthToken({ getItem: () => '{"value":""}' })).toBeNull();
    expect(readDeepSeekAuthToken({ getItem: () => '   ' })).toBeNull();
  });

  it('非 chat 键、缺少 token 或空历史都返回 null', async () => {
    const fetchImpl = vi.fn();
    const hydrator = createHistoryHydrator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAuthToken: () => null,
    });
    expect(await hydrator('route:/')).toBeNull();
    expect(await hydrator('chat:abc12345')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('成功请求后返回可渲染事件，鉴权使用 Bearer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        biz_data: {
          chat_messages: [
            message('USER', 10, [{ type: 'REQUEST', content: '远程问题' }], 1),
            message('ASSISTANT', 11, [
              { type: 'THINK', content: '思考' },
              { type: 'RESPONSE', content: '远程回答' },
            ], 2),
          ],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const hydrator = createHistoryHydrator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAuthToken: () => 'token-x',
      now: () => 1234,
    });

    const session = await hydrator('chat:abc12345');
    expect(session?.events.map((event) => event.type)).toEqual(['user-message', 'final-answer']);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v0/chat/history_messages?chat_session_id=abc12345');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-x');
  });

  it('接口失败或 code 非 0 返回 null', async () => {
    const failing = createHistoryHydrator({
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
      getAuthToken: () => 'token',
    });
    expect(await failing('chat:abc12345')).toBeNull();

    const badCode = createHistoryHydrator({
      fetchImpl: (async () => new Response(JSON.stringify({ code: 1 }), { status: 200 })) as typeof fetch,
      getAuthToken: () => 'token',
    });
    expect(await badCode('chat:abc12345')).toBeNull();
  });
});
