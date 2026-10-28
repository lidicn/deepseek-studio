/**
 * QD-R19 复现件 · 持久化与重启恢复接缝
 *
 * 真用：createAutomationManager、createWhitelistStore、persistConfigPatch、
 *      createTaskLoop、createMessageHistory、createWebEngine（引擎只为把"派发抛错"接成真链路）。
 * 假用：onTaskTrigger 里的 agentSender（按 desktop-host.ts:1125-1133 的逐字形状复刻）、
 *        页面 dispatch。
 * 与生产逐条对齐：
 *   - 定时任务触发装配 = desktop-host.ts:1124-1136（onTaskTrigger 内 try/await agentSender/catch→console.warn）。
 *   - 白名单 store 的 fs 依赖 = desktop-host.ts:395-400（readFile=fs.readFileSync utf-8，
 *     writeFile=fs.writeFileSync 直写、无 .tmp+rename）。
 *   - 配置写回 = workspace.ts:255-283 无注入钩子的真 fs 分支（readFileSync / writeFileSync mode 0600）。
 * 面（08:37 现读，复制树 == 实时盘逐字节一致，且六枚源文件 disk-LF == HEAD blob）：
 *   automation=7d3c838a / consent-whitelist-store=f52dd0de / workspace=61a71d4e(含 CRLF，LF 归一=f6816f22)
 *   web-engine=a7b0f5d4 / task-loop=505588f5 / message-history=906d551a / HEAD=dcedede
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAutomationManager } from '../../src/host/automation';
import { createWhitelistStore } from '../../src/host/consent-whitelist-store';
import { persistConfigPatch } from '../../src/host/workspace';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createAgentLoop } from '../../src/host/agent-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createWebEngine } from '../../src/host/engine/web-engine';
import type { ExecuteResult } from '../../src/capabilities/types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let scratchSeq = 0;
function scratchDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `qd-r19-${tag}-${Date.now().toString(36)}-${scratchSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 复刻 desktop-host.ts:1124-1136 的 onTaskTrigger：内部 try/catch 只 console.warn。 */
function makeProductionShapedTrigger(agentSender: (prompt: string) => Promise<void>) {
  return async (task: { type: string; payload: { prompt?: string } }): Promise<void> => {
    if (task.type === 'prompt' && task.payload.prompt) {
      try {
        await agentSender(task.payload.prompt);
      } catch (err) {
        console.warn(`[automation] prompt task failed: ${err}`);
      }
    }
  };
}

const baseTaskInput = {
  name: '每日晨报',
  cron: '0 9 * * *',
  type: 'prompt' as const,
  payload: { prompt: '总结昨天的日志' },
  enabled: false,
};

describe('QD-R19 · 持久化与重启恢复', () => {
  it('CONTROL-1：白名单 store 经文件往返持久（证明注入式 fs 就是生产契约）', () => {
    const mem = new Map<string, string>();
    const deps = {
      homedir: '/home/user',
      readFile: (p: string) => {
        if (!mem.has(p)) throw new Error('ENOENT');
        return mem.get(p)!;
      },
      writeFile: (p: string, data: string) => { mem.set(p, data); },
      mkdirp: () => {},
    };
    const store1 = createWhitelistStore(deps);
    store1.add({ toolId: 'file.write', action: 'write', pathPattern: 'logs/**', workspaceHash: 'ws-1' });
    store1.add({ toolId: 'shell.exec', action: 'exec', pathPattern: 'bin/**', workspaceHash: 'ws-1' });

    const store2 = createWhitelistStore(deps); // 新进程 = 新实例，只能从文件恢复
    const got = store2.list('ws-1');
    console.log(`[CONTROL-1] 重启后条目数=${got.length} toolIds=${JSON.stringify(got.map((e) => e.toolId))}`);
    expect(got.length).toBe(2);
  });

  it('CONTROL-2：定时任务成功路径记 success（证明 manager 与日志形状可信）', async () => {
    const dir = scratchDir('ctrl2');
    let delivered = '';
    const mgr = createAutomationManager({
      storageDir: dir,
      onTaskTrigger: makeProductionShapedTrigger(async (p) => { delivered = p; }),
    });
    mgr.start();
    const task = mgr.create(baseTaskInput);
    const log = await mgr.runNow(task.id);
    const stored = mgr.get(task.id)!;
    console.log(`[CONTROL-2] log.status=${log?.status} lastRunStatus=${stored.lastRunStatus} 送达=${JSON.stringify(delivered)} 文件=${path.join(dir, 'automation-logs.json')}`);
    expect(log?.status).toBe('success');
    expect(delivered).toBe('总结昨天的日志');
    mgr.stop();
  });

  it('REPRO-A：agentSender 抛错被 onTaskTrigger 吞掉 ⇒ 失败任务记成 success、runCount 照加', async () => {
    const dir = scratchDir('reproa');
    const mgr = createAutomationManager({
      storageDir: dir,
      // 与生产同形：内部 catch 只 warn，不外抛 ⇒ executeTask 永远走 success 分支
      onTaskTrigger: makeProductionShapedTrigger(async () => {
        throw new Error('agent-busy');
      }),
    });
    mgr.start();
    const task = mgr.create(baseTaskInput);
    const log = await mgr.runNow(task.id);
    const stored = mgr.get(task.id)!;
    console.log(`[REPRO-A] log.status=${log?.status} log.error=${JSON.stringify(log?.error)} lastRunStatus=${stored.lastRunStatus} runCount=${stored.runCount} output=${JSON.stringify(log?.output)}`);
    console.log(`[REPRO-A] 落盘日志原文=${JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'automation-logs.json'), 'utf-8')))}`);
    expect(log?.status, '提示词根本没送达页面，执行记录不该记成 success').not.toBe('success');
    expect(stored.lastRunStatus, '任务统计的 lastRunStatus 不该停在 success').not.toBe('success');
    mgr.stop();
  });

  it('REPRO-B：崩在中途的日志重启后永远 running，且任务侧 lastRunStatus 仍停在上一轮 success', async () => {
    const dir = scratchDir('repro-b');
    let mode: 'ok' | 'hang' = 'ok';
    // 第一"进程"：第二轮触发后 promise 永不 settle（= 进程在 updateLog 之前退出/被丢弃）
    const mgr1 = createAutomationManager({
      storageDir: dir,
      onTaskTrigger: makeProductionShapedTrigger(async () => {
        if (mode === 'hang') return new Promise<void>(() => { /* 永不 resolve */ });
      }),
    });
    mgr1.start();
    const task = mgr1.create({ ...baseTaskInput, enabled: false });
    await mgr1.runNow(task.id); // 第一轮真成功：lastRunStatus=success 落盘
    mode = 'hang';
    void mgr1.runNow(task.id);
    await sleep(30); // addLog(status:'running') 已同步落盘
    mgr1.stop();

    // 第二"进程"：同一 storageDir 重启
    const mgr2 = createAutomationManager({ storageDir: dir, onTaskTrigger: async () => {} });
    mgr2.start();
    const logs = mgr2.logs(task.id);
    const stored = mgr2.get(task.id)!;
    console.log(`[REPRO-B] 重启后日志条数=${logs.length} 首条=${JSON.stringify(logs[0])}`);
    console.log(`[REPRO-B] 任务侧 lastRunAt=${stored.lastRunAt} lastRunStatus=${stored.lastRunStatus} runCount=${stored.runCount}`);
    expect.soft(logs[0]?.status, '重启后仍显示 running 的孤儿日志必须被清算（宿主无 boot 扫尾）').not.toBe('running');
    expect(stored.lastRunStatus, '真实最后一轮死在中途，任务侧统计却仍显示上一轮的 success').not.toBe('success');
    mgr2.stop();
  });

  it('REPRO-C：白名单文件半截 ⇒ load 静默返空（无 error 字段），下一次 add 直接覆写、原条目永久丢失', () => {
    const mem = new Map<string, string>();
    const deps = {
      homedir: '/home/user',
      readFile: (p: string) => {
        if (!mem.has(p)) throw new Error('ENOENT');
        return mem.get(p)!;
      },
      writeFile: (p: string, data: string) => { mem.set(p, data); },
      mkdirp: () => {},
    };
    const store1 = createWhitelistStore(deps);
    store1.add({ toolId: 'file.write', action: 'write', pathPattern: 'logs/**', workspaceHash: 'ws-1' });
    store1.add({ toolId: 'shell.exec', action: 'exec', pathPattern: 'bin/**', workspaceHash: 'ws-1' });
    store1.add({ toolId: 'file.delete', action: 'delete', pathPattern: 'tmp/**', workspaceHash: 'ws-1' });
    const wlPath = store1.path;
    const full = mem.get(wlPath)!;
    // 崩溃留在磁盘上的形状：writeFileSync 以 'w' 打开即截断，写一半断电 ⇒ 前缀碎片
    mem.set(wlPath, full.slice(0, 60));

    const store2 = createWhitelistStore(deps);
    const loaded = store2.load();
    console.log(`[REPRO-C] 半截文件长度=${mem.get(wlPath)!.length} 原文=${JSON.stringify(mem.get(wlPath))}`);
    console.log(`[REPRO-C] load()=${JSON.stringify(loaded)}`);
    expect.soft(loaded.error, '解析失败必须以 error 上报（loadTasks 有同款上报，此处没有）').toBeDefined();

    store2.add({ toolId: 'file.write', action: 'write', pathPattern: 'new/**', workspaceHash: 'ws-1' });
    const after = JSON.parse(mem.get(wlPath)!).entries.length;
    console.log(`[REPRO-C] add 之后文件条目数=${after}（原本 3 条 + 新 1 条应为 4）`);
    expect(after, '半截文件被 add 静默覆写，原 3 条持久同意永久消失').toBeGreaterThanOrEqual(4);
  });

  it('REPRO-D：白名单文件形状异常（version 对、entries 缺）⇒ list() 抛 TypeError，且抛点在工具调用链上', () => {
    const dir = scratchDir('reprod');
    const cfgDir = path.join(dir, '.config', 'deepseek-studio');
    fs.mkdirSync(cfgDir, { recursive: true });
    const wlPath = path.join(cfgDir, 'consent-whitelist.json');
    // 生产 fs 依赖形状 = desktop-host.ts:395-400
    fs.writeFileSync(wlPath, JSON.stringify({ version: 1 }), 'utf-8');
    const store = createWhitelistStore({
      homedir: dir,
      readFile: (p) => fs.readFileSync(p, 'utf-8'),
      writeFile: (p, d) => fs.writeFileSync(p, d, 'utf-8'),
      mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    });
    console.log(`[REPRO-D] store.path=${store.path} 目标=${wlPath}`);

    let errNoHash: unknown = null;
    let errWithHash: unknown = null;
    try {
      const v = store.list() as unknown;
      console.log(`[REPRO-D] 无 wsHash 时 list() 返回=${JSON.stringify(v)} typeof=${typeof v}（routeConsent 会 for..of 它）`);
    } catch (e) { errNoHash = e; }
    try {
      store.list('ws-abc');
    } catch (e) { errWithHash = e; }
    console.log(`[REPRO-D] list('ws-abc') 抛错=${errWithHash instanceof Error ? errWithHash.constructor.name + ': ' + errWithHash.message : String(errWithHash)}`);
    expect(errWithHash, 'schema 未校验：畸形文件不得让工具调用链抛 TypeError').toBe(null);
    expect(errNoHash, '无 wsHash 分支返回非数组，routeConsent:138 的 for..of 同样炸').toBe(null);
  });

  it('REPRO-E：单条工具派发抛错 ⇒ engine.send 冒泡、整回合以 reject 结束（断流面）', async () => {
    const history = createMessageHistory();
    const engine = createWebEngine({
      dispatch: async (tool: string): Promise<ExecuteResult> => {
        if (tool === 'chat-insert') {
          // 与 desktop-host.ts:1304 → whitelistStore.list(wsHash) 抛 TypeError 同形
          throw new TypeError("Cannot read properties of undefined (reading 'filter')");
        }
        return { ok: true, data: {} };
      },
      toolCallCounter: { current: 0 },
      isStopped: () => false,
      pollIntervalMs: 10,
      stepTimeoutMs: 200,
    });
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });
    let caught: unknown = null;
    let content: string | undefined;
    try {
      const r = await loop.run('正常提问');
      content = r.content;
    } catch (e) { caught = e; }
    console.log(`[REPRO-E] run 结果 content=${JSON.stringify(content)} 抛出=${caught instanceof Error ? caught.constructor.name + ': ' + caught.message : String(caught)}`);
    expect(caught, '一条工具的派发异常应被结算成可判定的失败终态（ExecuteResult.ok=false），而不是让整回合 reject；且 maxSendRetries 对抛错完全不生效').toBe(null);
  });

  it('REPRO-E2：同一抛错在面板主路（AgentLoop）以内部 TypeError 文案收尾，无重试无归因', async () => {
    const events: { type: string; text?: string }[] = [];
    const stopFlag = { stopped: false };
    const engine = createWebEngine({
      dispatch: async (): Promise<ExecuteResult> => {
        throw new TypeError("Cannot read properties of undefined (reading 'filter')");
      },
      toolCallCounter: { current: 0 },
      isStopped: () => stopFlag.stopped,
      pollIntervalMs: 10,
      stepTimeoutMs: 200,
    });
    const loop = createAgentLoop({ engine, onEvent: (e) => events.push(e), stopFlag, throttleBetweenSteps: false, maxSteps: 3 });
    await loop.send('正常提问');
    const err = events.find((e) => e.type === 'error');
    console.log(`[REPRO-E2] 事件序列=${JSON.stringify(events.map((e) => `${e.type}:${(e.text ?? '').slice(0, 40)}`))}`);
    expect(err?.text, '用户侧错误文案必须是可归因的中文提示，不能是内部 TypeError 原文（且无任何重试/归因）').not.toMatch(/Cannot read properties/);
    expect(!!err, '回合必须以 error 终态收尾').toBe(true);
  });

  it('CONTROL-3：配置文件完好时 persistConfigPatch 保留未知键', () => {
    const dir = scratchDir('ctrl3');
    const cfgDir = path.join(dir, '.config', 'deepseek-studio');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ token: 't-1', apiEngine: { apiKey: 'k-1' }, workspaceRoot: 'E:/work', policyMode: 'safe' }, null, 2), 'utf-8');
    const res = persistConfigPatch({ policyMode: 'auto' }, { homedir: dir });
    const bag = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    console.log(`[CONTROL-3] ok=${res.ok} 键=${JSON.stringify(Object.keys(bag))}`);
    expect(res.ok).toBe(true);
    expect(bag.token).toBe('t-1');
  });

  it('REPRO-F：config.json 半截 ⇒ persistConfigPatch 以空配置起步并覆写，token/apiKey/workspaceRoot 全丢', () => {
    const dir = scratchDir('reprof');
    const cfgDir = path.join(dir, '.config', 'deepseek-studio');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, 'config.json');
    const original = JSON.stringify({ token: 't-1', apiEngine: { apiKey: 'k-1' }, workspaceRoot: 'E:/work', policyMode: 'safe' }, null, 2);
    // 崩溃留在磁盘上的形状：直写（无 .tmp+rename）中途断电 ⇒ 前缀碎片
    fs.writeFileSync(cfgPath, original.slice(0, 70), 'utf-8');
    console.log(`[REPRO-F] 磁盘现状=${JSON.stringify(fs.readFileSync(cfgPath, 'utf-8'))}`);

    const res = persistConfigPatch({ policyMode: 'auto' }, { homedir: dir });
    const bag = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    console.log(`[REPRO-F] persist=${JSON.stringify(res)} 覆写后键=${JSON.stringify(Object.keys(bag))} 全文=${JSON.stringify(fs.readFileSync(cfgPath, 'utf-8'))}`);
    expect(res.ok, '解析失败不得静默以空配置覆写用户配置（token/apiKey/workspaceRoot 消失）').toBe(false);
    expect(bag.token, '原 token 键必须仍在').toBe('t-1');
  });
});
