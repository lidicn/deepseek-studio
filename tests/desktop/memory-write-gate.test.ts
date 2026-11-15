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

/**
 * 2026-11-15 卡⑨：终局拒绝必须带**机器可读停止信号**（`terminate:true`）。
 *
 * 真机：一个 turn 内 `memory_save` 被拒 **135 次**、AutoForge 一次没被调用——硬闸每次
 * 都拦住了，但返回体里没有停止信号，模型就一直重试到 `MAX_LOOP=25` 撞顶。
 *
 * 这两枚断言走**真实入口** `executeTool`（不打桩内部函数），测的是**接线**：
 * `tests/desktop/tool-result-format.test.ts` 那 8 条只喂纯函数入参形状，
 * 生产端从不产生那种形状（`terminate` 在 `result` 里），所以全绿也抓不到这个缺陷。
 */
describe('终局拒绝带停止信号（接线级，真实入口 executeTool）', () => {
  it('硬闸拒绝 ⇒ terminate:true，reason 仍是规范码（不带人话前缀）', async () => {
    const r = await saveVia({ type: 'user', name: '无话语信号', content: '内容' }, CONV);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-no-user-turn');
    expect(r.terminate).toBe(true);
  });

  it('参数再改也不变的另一码（任务快照）同样带 terminate', async () => {
    host.recordUserTurn(CONV, '请记住：用 af_list_entities 查设备');
    const r = await saveVia(
      { type: 'project', name: '任务', content: '调用 af_list_entities 查询客厅设备' },
      CONV,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory-save-task-snapshot');
    expect(r.terminate).toBe(true);
  });

  it('真放行 ⇒ 不带 terminate（成功不许终止续跑）', async () => {
    host.recordUserTurn(CONV, '请记住：我偏好中文回复，项目一律用 PowerShell');
    const r = await saveVia({ type: 'user', name: '语言偏好2', content: '偏好中文回复' }, CONV);
    expect(r.ok).toBe(true);
    expect(r.terminate).toBeUndefined();
  });

  it('无可信页的 DOM 能力（no-page-for-dom-capability）**不带** terminate（2026-11-15 复议裁定）', async () => {
    // 裁定而非疏漏：页端注册/刷新/导航后 DOM 能力会变可用 ⇒ 不必然同果，
    // 判终局会让宿主直接发 terminate、注入层整批跳过续跑，模型连"请打开页面"都说不出来。
    // 它的刷屏风险由 shared 侧的通用熔断轴（NON_TERMINAL_FUSE_THRESHOLD = 5）兜。
    // ★ 谁把这行的期望改成 true，等于把复议裁定推翻——先报 PM。
    const r = await host.invokeTool('chat-read', {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-page-for-dom-capability');
    expect(r.terminate).toBeUndefined();
  });

  it('能力不存在（unknown-capability，注册表闸）也带 terminate', async () => {
    // 2026-11-15 ⑨-补：原先"能力不存在"这一族只有分类锁、没有接线锁。
    // 走真实入口 invokeTool 打一个不在注册表里的名字：不是 memory.save（避开硬闸）、
    // 也不是 chat-read（避开 DOM 回退）。
    const r = await host.invokeTool('studio-definitely-not-a-capability', {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown-capability');
    expect(r.terminate).toBe(true);
  });

  it('【如实记录】宿主能力表尾出口 `no-capability` 走不到：真实入口打不存在的名字回的是 unknown-capability', async () => {
    // 这不是锁，是把一条**不可达性**写进测试，免得下一个人照 PM 卡面写"打不存在的名字 ⇒ no-capability"。
    // 现读 `executeTool` 的顺序：① 注册表闸 `registry.get(name)` → 没登记就 `finish('unknown-capability')`；
    // ② 执行侧闸 `side === 'host' ? hostTools.get(name) : capabilities.get(name)` → 没找到 `finish('unknown-capability')`；
    // ③ 最后 `const cap = capabilities.get(name)` —— 与 ② 同一张表、同一次调用内无人增删，
    //    所以 ② 通过 ⇒ ③ 必然也拿到同一个对象 ⇒ `no-capability` 那一行**当前不可达**。
    // ⇒ 它的接线（`withTerminalSignal`）目前**无法用行为锁咬住**，只能靠码表＋本注释；
    //    已报 PM 裁定：是删掉这个死出口，还是接受"无行为锁"。
    const r = await host.invokeTool('studio-definitely-not-a-capability', {});
    expect(r.reason).toBe('unknown-capability'); // 与上一枚同源：都是 unknown-capability
  });
});
