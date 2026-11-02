/**
 * M1-C 接线层回归测试：页面侧的完成哨兵必须**真的**能到达引擎。
 *
 * PM 核实的一条关键事实：`readFinishSentinel` 在 `src/` 里原本**零注入方**
 * （只有 `web-engine.ts` 自己的声明与消费）→ `interrupted` 是**死代码**。
 *
 * 本文件锁三段链路：
 *   ① **协议**：页端 → 宿主的 `finish-sentinel` 消息能被 hub 接收并存下；
 *   ② **归属**：按 botId 分开存取，且**上一轮的陈旧结论会被挡掉**（`sinceMs`）；
 *   ③ **引擎接线**：`createWebEngine({ readFinishSentinel })` 真的把结论喂进
 *      `decideCompletion` → 判出 `'interrupted'`。
 *
 * 负控自证：把①的接收分支去掉 / 把②的 `sinceMs` 过滤去掉 / 把③的回调摘掉，
 * 对应用例必须红（详见 `docs/验收报告/` 里的 M1-C 报告）。
 */
import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { createPageRuntimeHub } from '../../src/host/page-runtime';
import { createWebEngine } from '../../src/host/engine/web-engine';
import type { PageToHostMessage } from '../../src/host/protocol';

interface HubFixture {
  hub: ReturnType<typeof createPageRuntimeHub>;
  port: number;
  close(): Promise<void>;
}

async function startHub(): Promise<HubFixture> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = Number((server.address() as { port: number }).port);
  const hub = createPageRuntimeHub({ server, token: 't' });
  return {
    hub,
    port,
    close: async () => {
      hub.dispose();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** 连一个假页：握手后由测试驱动它发消息。 */
function connectPage(port: number): Promise<{ ws: WebSocket; send(m: PageToHostMessage): void }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
      resolve({
        ws,
        send: (m: PageToHostMessage) => ws.send(JSON.stringify(m)),
      });
    });
  });
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('M1-C 接线：页面侧完成哨兵能到达宿主', () => {
  it('① 页端发 finish-sentinel → hub 存下结论（按 botId）', async () => {
    const f = await startHub();
    try {
      const page = await connectPage(f.port);
      await tick();
      page.send({ type: 'finish-sentinel', round: 7, sawFinishSentinel: false });
      await tick();
      // hub 读得到 false（本轮页面明确说「没有哨兵」）。
      expect(f.hub.readFinishSentinel('main')).toBe(false);
      page.ws.close();
    } finally {
      await f.close();
    }
  });

  it('① 页端发 true → hub 存下 true', async () => {
    const f = await startHub();
    try {
      const page = await connectPage(f.port);
      await tick();
      page.send({ type: 'finish-sentinel', round: 8, sawFinishSentinel: true });
      await tick();
      expect(f.hub.readFinishSentinel('main')).toBe(true);
      page.ws.close();
    } finally {
      await f.close();
    }
  });

  it('② 页端没上报过 → hub 返回 undefined（绝不能当 false）', async () => {
    const f = await startHub();
    try {
      const page = await connectPage(f.port);
      await tick();
      expect(f.hub.readFinishSentinel('main')).toBeUndefined();
      page.ws.close();
    } finally {
      await f.close();
    }
  });

  it('② 上一轮的陈旧结论被 sinceMs 挡掉（否则会误判本轮）', async () => {
    const f = await startHub();
    try {
      const page = await connectPage(f.port);
      await tick();
      page.send({ type: 'finish-sentinel', round: 1, sawFinishSentinel: false });
      await tick();
      // 用「本轮起点在上一轮之后」读 → 拿不到（陈旧）。
      const later = Date.now() + 1000;
      expect(f.hub.readFinishSentinel('main', later)).toBeUndefined();
      // 用「本轮起点在上一轮之前」读 → 拿得到。
      expect(f.hub.readFinishSentinel('main', Date.now() - 10_000)).toBe(false);
      page.ws.close();
    } finally {
      await f.close();
    }
  });

  it('② 不同 bot 的结论互相隔离', async () => {
    const f = await startHub();
    try {
      const page = await connectPage(f.port);
      await tick();
      page.send({ type: 'finish-sentinel', round: 1, sawFinishSentinel: false });
      await tick();
      expect(f.hub.readFinishSentinel('main')).toBe(false);
      // 别的 bot 没上报 → undefined（不会串味）。
      expect(f.hub.readFinishSentinel('other-bot')).toBeUndefined();
      page.ws.close();
    } finally {
      await f.close();
    }
  });
});

describe('M1-C 接线：结论真的能驱动引擎判出 interrupted', () => {
  /**
   * ④ **接线层结构锁**（防「零注入方」回归）。
   *
   * 负控实测：**把 `desktop-host.ts` 里那行 `readFinishSentinel:` 接线摘掉，
   * 本文件其它 9 例仍全部绿** —— 因为它们只测 hub 与引擎，测不到「宿主有没有把
   * hub 的结论接到引擎上」。这正是 PM 核实的那条：`readFinishSentinel` 曾**零注入方**
   * → `interrupted` 是**死代码**，而当时所有单测都是绿的。
   *
   * 宿主不暴露 registry/引擎实例（`BotInstance.engine` 在 `bot/types.ts` 里，
   * 但 `desktop-host` 不把它透出来），所以这一层用**源码结构锁**覆盖：
   * 断言 `desktop-host.ts` 里确实存在「把 hub 的哨兵接到 WebEngine」的那一行。
   *
   * 说明：结构锁锁的是「接线**存在**」这一事实（防止再次变成死代码），
   * **不是**行为断言；真正的行为正确性由上面的 ① ② ③ 三组 + 真机验证兜底。
   */
  it('④ desktop-host 把 hub 的哨兵接到 WebEngine（接线不得消失）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../src/host/desktop-host.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/readFinishSentinel:\s*\(roundStartedAt\)\s*=>\s*hub\?\.readFinishSentinel\(/);
  });

  it('④ page-runtime 真的接收 finish-sentinel 消息（协议分支不得消失）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../src/host/page-runtime.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/msg\.type === 'finish-sentinel'/);
    expect(src).toMatch(/finishSentinels\.set\(/);
  });

  it('④ 协议里 finish-sentinel 消息类型存在（页端要靠它上报）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../src/host/protocol.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/type: 'finish-sentinel'; round: number; sawFinishSentinel: boolean/);
  });

  /**
   * 造一个最小 WebEngine。
   *
   * 关键：假 `chat-read` 的返回形状必须**对齐引擎真正读的字段**
   * （`data.messages[]` + `data.mirror.{count,assistantTexts,lastAssistantText}`），
   * 且 **mirror.count 必须随读取次数增长** —— 引擎用「镜像助手条数增长」当**身份信号**
   * 判「这是本轮的新答案」，count 不涨就一直判不出新文本 → 空转到看门狗。
   * 另外**文本必须恒定**：引擎要「快照连续 2 次不变」才判完成，文本每轮变 → 永远不稳定。
   */
  function makeEngine(sentinel: boolean | undefined) {
    let reads = 0;
    const engine = createWebEngine({
      dispatch: async (tool) => {
        if (tool !== 'chat-read') return { ok: true };
        reads += 1;
        const text = '模型答了一半';
        return {
          ok: true,
          data: {
            count: reads,
            messages: [{ text }],
            mirror: { count: reads, assistantTexts: [text], lastAssistantText: text },
          },
        };
      },
      toolCallCounter: { current: 0 },
      pollIntervalMs: 5,
      maxEmptyReads: 50,
      readFinishSentinel: () => sentinel,
    });
    return { engine };
  }

  it('③ 注入 readFinishSentinel=false → 引擎判 completion=interrupted', async () => {
    const { engine } = makeEngine(false);
    const r = await engine.send('测试');
    expect(r.completion).toBe('interrupted');
    expect(r.sawFinishSentinel).toBe(false);
  });

  it('③ 注入 readFinishSentinel=true → 引擎判 completion=complete', async () => {
    const { engine } = makeEngine(true);
    const r = await engine.send('测试');
    expect(r.completion).toBe('complete');
    expect(r.sawFinishSentinel).toBe(true);
  });

  it('③ 未注入 readFinishSentinel → 判 complete（老页面兼容，不判 interrupted）', async () => {
    let reads = 0;
    const engine = createWebEngine({
      dispatch: async (tool) => {
        if (tool !== 'chat-read') return { ok: true };
        reads += 1;
        const text = '模型答了一半';
        return {
          ok: true,
          data: {
            count: reads,
            messages: [{ text }],
            mirror: { count: reads, assistantTexts: [text], lastAssistantText: text },
          },
        };
      },
      toolCallCounter: { current: 0 },
      pollIntervalMs: 5,
      maxEmptyReads: 50,
    });
    const r = await engine.send('测试');
    expect(r.completion).toBe('complete');
    expect(r.sawFinishSentinel).toBeUndefined();
  });

  it('③ readFinishSentinel 抛错 → 当成「不知道」，不中断本轮', async () => {
    let reads = 0;
    const engine = createWebEngine({
      dispatch: async (tool) => {
        if (tool !== 'chat-read') return { ok: true };
        reads += 1;
        const text = '模型答了一半';
        return {
          ok: true,
          data: {
            count: reads,
            messages: [{ text }],
            mirror: { count: reads, assistantTexts: [text], lastAssistantText: text },
          },
        };
      },
      toolCallCounter: { current: 0 },
      pollIntervalMs: 5,
      maxEmptyReads: 50,
      readFinishSentinel: () => {
        throw new Error('page gone');
      },
    });
    const r = await engine.send('测试');
    // 读哨兵失败不能把本轮带崩，也不能误判 interrupted。
    expect(r.completion).toBe('complete');
    expect(r.sawFinishSentinel).toBeUndefined();
  });
});
