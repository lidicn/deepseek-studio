// @vitest-environment node
/**
 * 2026-11-13 长期记忆写入硬闸回归（真机 `chat:ff7fc62f` 之后加的）。
 *
 * 走**真实入口** `host.executeTool('memory.save', …)`（不在内部函数上打桩），
 * 覆盖三个拒绝码 + 否定语境 + 一条真放行：
 *   - `memory-save-task-snapshot`        任务快照（`type=project` 含任务句式/工具名）**无条件**拒；
 *   - `memory-save-no-user-turn`         宿主拿不到本轮用户话语 ⇒ fail-closed；
 *   - `memory-save-needs-explicit-instruction` 有话语但没有记忆指令 ⇒ 拒；
 *   - 否定语境「不用记住这个」**必须拒**（含 `记住` 也要被否定词吃掉）；
 *   - 真放行：用户明确说「请记住…」+ 中性内容 ⇒ 真写进库。
 *
 * 负控：把 `evaluateMemorySaveGate` 改成恒 `{allow:true}` ⇒ 前四条全红；
 * 逐字节还原后复绿。（见交卷里的命令与还原后 blob16。）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DesktopHost } from '../../src/host/desktop-host';
import { memoryConversationId } from '../../src/host/bot/slot-runtime';

const CONV = 'mem-gate-conv';

let host: DesktopHost;
let tmpDir: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-memgate-'));
  previousConfigDir = process.env.STUDIO_CONFIG_DIR;
  process.env.STUDIO_CONFIG_DIR = tmpDir;
  vi.resetModules();
  const { createDesktopHost } = await import('../../src/host/desktop-host');
  host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    policyMode: 'full',
  });
  await host.start();
});

afterEach(async () => {
  try {
    await host.stop();
  } finally {
    if (previousConfigDir === undefined) delete process.env.STUDIO_CONFIG_DIR;
    else process.env.STUDIO_CONFIG_DIR = previousConfigDir;
    const { getMemoryStore } = await import('../../src/host/memory-store');
    getMemoryStore().close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** 走 executeTool 真实链路（自带一次性 grant，模拟宿主内部调用）。 */
async function saveVia(params: Record<string, unknown>, conversationId: string | undefined) {
  const grant = await host.issueGrant({
    documentId: 'mem-gate-test',
    sessionId: 'mem-gate-test',
    requestId: crypto.randomUUID(),
    scope: 'memory.save',
    origin: 'https://chat.deepseek.com',
  });
  return host.executeTool('memory.save', params, grant, undefined, conversationId);
}

async function listedNames(): Promise<string[]> {
  const r = await host.invokeTool('memory.list', {});
  const rows = (r.data as { memories?: Array<{ name: string }> }).memories ?? [];
  return rows.map((m) => m.name);
}

describe('记忆写入硬闸（真实入口 executeTool）', () => {
  it('任务快照：即便用户说了「记住」，type=project 含工具名也拒', async () => {
    host.recordUserTurn(CONV, '记住这个偏好');
    const r = await saveVia(
      {
        type: 'project',
        name: '客厅设备查询',
        content: '用户希望用 Autoforge 的 af_list_entities 查客厅有哪些设备',
      },
      CONV,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-task-snapshot');
    // 拒绝文本必须可读（模型要知道为什么、下一步怎么做），不能只有码。
    const text = (r.content ?? []).find((p) => p.type === 'text');
    expect(text && 'text' in text ? text.text : '').toContain('memory-save-task-snapshot');
    expect(await listedNames()).not.toContain('客厅设备查询');
  });

  it('没有本轮用户话语：缺 conversationId ⇒ memory-save-no-user-turn', async () => {
    const r = await saveVia({ type: 'user', name: '无上下文', content: '偏好中文' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-no-user-turn');
    expect(await listedNames()).not.toContain('无上下文');
  });

  it('有对话但没有落用户话语 ⇒ 同样拒绝（fail-closed）', async () => {
    const r = await saveVia({ type: 'user', name: '无话语', content: '偏好中文' }, CONV);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-no-user-turn');
  });

  it('本轮用户没让记 ⇒ memory-save-needs-explicit-instruction', async () => {
    host.recordUserTurn(CONV, '使用Autoforge mcp 查询客厅有哪些设备');
    const r = await saveVia({ type: 'user', name: '用户角色', content: '用户管理客厅设备' }, CONV);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-needs-explicit-instruction');
    expect(await listedNames()).not.toContain('用户角色');
  });

  it('否定语境「不用记住这个」必须拒（含「记住」也不算指令）', async () => {
    host.recordUserTurn(CONV, '不用记住这个，只是临时查一下');
    const r = await saveVia({ type: 'user', name: '临时', content: '临时内容' }, CONV);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-needs-explicit-instruction');
  });

  it('用户明确说「请记住…」+ 中性内容 ⇒ 真放行并落库', async () => {
    host.recordUserTurn(CONV, '请记住：我偏好中文回复，项目一律用 PowerShell');
    const r = await saveVia({ type: 'user', name: '语言偏好', content: '偏好中文回复' }, CONV);
    expect(r.ok).toBe(true);
    expect(await listedNames()).toContain('语言偏好');
  });
});

/**
 * bot 路径（PM 定 (a)）：`slot-runtime` 的 `InvokeTool` 补第 4 参后，bot 侧工具调用的
 * 对话键是 `memoryConversationId(botId)` = `bot:<botId>`；证据由 `agent-channel` 在
 * `bot.sendMessage(text)` 之前落。这三条锁住「bot 侧既写得进、也不会被无证据放行」。
 */
describe('bot 路径（conversationId = bot:<botId>）', () => {
  const BOT_CONV = memoryConversationId('main');

  it('bot 对话里用户说过「记住」→ memory.save 放行并落库', async () => {
    host.recordUserTurn(BOT_CONV, '记住这个偏好：我喜欢深色主题');
    const r = await saveVia({ type: 'user', name: '主题偏好', content: '喜欢深色主题' }, BOT_CONV);
    expect(r.ok).toBe(true);
    expect(await listedNames()).toContain('主题偏好');
  });

  it('bot 对话里只有普通消息（没有记忆指令）→ needs-explicit-instruction', async () => {
    host.recordUserTurn(BOT_CONV, '帮我看看这个报错怎么修');
    const r = await saveVia({ type: 'user', name: '报错', content: '用户遇到报错' }, BOT_CONV);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-needs-explicit-instruction');
  });

  it('bot 从没发过消息 → no-user-turn（fail-closed）', async () => {
    const r = await saveVia({ type: 'user', name: '无证据', content: '内容' }, memoryConversationId('ghost'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-no-user-turn');
  });
});
