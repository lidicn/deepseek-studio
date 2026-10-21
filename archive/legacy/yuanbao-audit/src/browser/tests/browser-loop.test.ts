/**
 * browser-loop 单元测试：mock 掉浏览器会话，只验证状态机。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserLoop, type BrowserLoopHandle } from '../browser-loop';
import type { BrowserSessionHandle } from '../session';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MockSession extends BrowserSessionHandle {
  __sent: string[];
  __setText(t: string): void;
  __setLoggedIn(v: boolean): void;
  __setGenerating(v: boolean): void;
}

function mockSession(): MockSession {
  let text = '';
  let loggedIn = false;
  let generating = false;
  const sent: string[] = [];
  return {
    context: {} as MockSession['context'],
    page: {} as MockSession['page'],
    readText: async () => text,
    isLoggedIn: async () => loggedIn,
    isGenerating: async () => generating,
    sendText: async (t: string) => {
      sent.push(t);
      return { ok: true };
    },
    screenshot: async () => Buffer.from(''),
    close: async () => {},
    __sent: sent,
    __setText(t: string) { text = t; },
    __setLoggedIn(v: boolean) { loggedIn = v; },
    __setGenerating(v: boolean) { generating = v; },
  };
}

test('未登录 → phase=waiting-login，不发任何消息', async () => {
  const s = mockSession();
  const loop = createBrowserLoop({ session: s, target: 5, intervalMs: 10 });
  await loop.run();
  await sleep(60);
  loop.dispose();
  assert.equal(loop.state.phase, 'waiting-login');
  assert.equal(s.__sent.length, 0);
});

test('登录后检测到新轮次，seenRounds 累计', async () => {
  const s = mockSession();
  const loop = createBrowserLoop({ session: s, target: 5, intervalMs: 10 });
  s.__setLoggedIn(true);
  s.__setText('对话正文\nROUND_1_DONE\n继续干活');
  await loop.run();
  await sleep(60);
  loop.dispose();
  assert.ok(loop.state.seenRounds.includes(1), `seenRounds=${loop.state.seenRounds}`);
});

test('达到目标轮次 → done', async () => {
  const s = mockSession();
  const loop = createBrowserLoop({ session: s, target: 1, intervalMs: 10 });
  s.__setLoggedIn(true);
  s.__setText('ROUND_1_DONE');
  await loop.run();
  await sleep(80);
  // done 后不 schedule，dispose 幂等
  loop.dispose();
  assert.equal(loop.state.phase, 'done');
});

test('NEED_DECISION → paused，不盲发', async () => {
  const s = mockSession();
  const loop = createBrowserLoop({ session: s, target: 5, intervalMs: 10 });
  s.__setLoggedIn(true);
  s.__setText('ROUND_1_DONE\nNEED_DECISION');
  await loop.run();
  await sleep(80);
  loop.dispose();
  assert.equal(loop.state.phase, 'paused');
});

test('command continue 解除 paused', async () => {
  const s = mockSession();
  const loop = createBrowserLoop({ session: s, target: 5, intervalMs: 10 });
  s.__setLoggedIn(true);
  s.__setText('ROUND_1_DONE\nNEED_DECISION');
  await loop.run();
  await sleep(60);
  loop.command('continue');
  await sleep(60);
  loop.dispose();
  assert.equal(loop.state.phase, 'running');
});
