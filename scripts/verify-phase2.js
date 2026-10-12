// 第二阶段实机验证：before/afterToolCall 钩子 + 事件驱动工具循环
import { createToolHooks } from '../src/shared/tool-hooks.js';
import { createToolEventBus } from '../src/shared/tool-event-bus.js';
import { runToolCall } from '../src/shared/tool-loop.js';

console.log('=== 第二阶段实机验证 ===\n');

// ---- 测试 1：before 钩子拦截执行 ----
console.log('【测试 1】before 钩子返回 false 拦截执行');
const hooks1 = createToolHooks();
hooks1.registerBefore('shell.exec', () => false);
const result1 = await hooks1.runBefore('shell.exec', { command: 'dir' });
console.log(`  proceed: ${result1.proceed}（期望 false）`);
console.log(`  测试 ${result1.proceed === false ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 2：before 钩子修改参数 ----
console.log('【测试 2】before 钩子修改参数');
const hooks2 = createToolHooks();
hooks2.registerBefore('shell.exec', (params) => ({ params: { ...params, command: 'modified' } }));
const result2 = await hooks2.runBefore('shell.exec', { command: 'original' });
console.log(`  proceed: ${result2.proceed}`);
console.log(`  params.command: ${result2.params.command}（期望 modified）`);
console.log(`  测试 ${result2.params.command === 'modified' ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 3：after 钩子修改结果 ----
console.log('【测试 3】after 钩子修改结果');
const hooks3 = createToolHooks();
hooks3.registerAfter('shell.exec', (params, result) => ({ ...result, isError: true, terminate: true }));
const originalResult = { ok: true, data: { stdout: 'hello' }, isError: false };
const result3 = await hooks3.runAfter('shell.exec', { command: 'dir' }, originalResult);
console.log(`  isError: ${result3.isError}（期望 true）`);
console.log(`  terminate: ${result3.terminate}（期望 true）`);
console.log(`  测试 ${result3.isError === true && result3.terminate === true ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 4：通配符钩子 ----
console.log('【测试 4】通配符 * 钩子对所有工具生效');
const hooks4 = createToolHooks();
let called = 0;
hooks4.registerBefore('*', () => { called++; return; });
await hooks4.runBefore('shell.exec', {});
await hooks4.runBefore('file.read', {});
await hooks4.runBefore('mcp.call', {});
console.log(`  调用次数: ${called}（期望 3）`);
console.log(`  测试 ${called === 3 ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 5：事件总线订阅/发布 ----
console.log('【测试 5】事件总线订阅/发布');
const bus = createToolEventBus();
let received = null;
bus.on('after-call', (payload) => { received = payload; });
bus.emit('after-call', { toolName: 'shell.exec', ok: true });
console.log(`  收到事件: ${received ? JSON.stringify(received) : 'null'}`);
console.log(`  测试 ${received && received.toolName === 'shell.exec' ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 6：事件总线通配符订阅 ----
console.log('【测试 6】事件总线 * 通配符订阅');
const bus2 = createToolEventBus();
const events = [];
bus2.on('*', (event, payload) => { events.push(event); });
bus2.emit('before-call', {});
bus2.emit('after-call', {});
bus2.emit('call-error', {});
console.log(`  收到事件: ${events.join(', ')}（期望 before-call, after-call, call-error）`);
console.log(`  测试 ${events.length === 3 ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 7：取消订阅 ----
console.log('【测试 7】取消订阅后不再收到事件');
const bus3 = createToolEventBus();
let count = 0;
const unsub = bus3.on('after-call', () => { count++; });
bus3.emit('after-call', {});
unsub();
bus3.emit('after-call', {});
console.log(`  收到次数: ${count}（期望 1）`);
console.log(`  测试 ${count === 1 ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 8：完整工具循环（runToolCall）----
console.log('【测试 8】事件驱动工具循环 runToolCall');
const hooks8 = createToolHooks();
const bus8 = createToolEventBus();
const loopEvents = [];
bus8.on('*', (payload) => loopEvents.push(payload.event || payload));

let execCalled = false;
const execResult = { ok: true, data: { stdout: 'test output' }, content: [{ type: 'text', text: 'test output' }], isError: false };

const result8 = await runToolCall({
  toolName: 'shell.exec',
  params: { command: 'echo test' },
  execute: async () => { execCalled = true; return execResult; },
  hooks: hooks8,
  events: bus8,
});

console.log(`  execute 被调用: ${execCalled}`);
console.log(`  result.ok: ${result8.ok}`);
console.log(`  事件序列: ${loopEvents.join(' → ')}`);
console.log(`  测试 ${execCalled && result8.ok && loopEvents.includes('before-call') && loopEvents.includes('after-call') ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 9：工具循环中 before 钩子拦截 ----
console.log('【测试 9】工具循环中 before 钩子拦截（不执行 execute）');
const hooks9 = createToolHooks();
const bus9 = createToolEventBus();
hooks9.registerBefore('shell.exec', () => false);
let execCalled9 = false;
const result9 = await runToolCall({
  toolName: 'shell.exec',
  params: { command: 'echo test' },
  execute: async () => { execCalled9 = true; return { ok: true }; },
  hooks: hooks9,
  bus: bus9,
});
console.log(`  execute 被调用: ${execCalled9}（期望 false）`);
console.log(`  result.ok: ${result9.ok}`);
console.log(`  测试 ${!execCalled9 ? '✅ 通过' : '❌ 失败'}\n`);

// ---- 测试 10：无钩子时直通 ----
console.log('【测试 10】无钩子注册时行为等同于直通');
const hooks10 = createToolHooks();
const beforeResult = await hooks10.runBefore('shell.exec', { command: 'test' });
console.log(`  runBefore.proceed: ${beforeResult.proceed}（期望 true）`);
console.log(`  runBefore.params 不变: ${beforeResult.params.command === 'test'}`);
console.log(`  测试 ${beforeResult.proceed === true && beforeResult.params.command === 'test' ? '✅ 通过' : '❌ 失败'}\n`);

console.log('=== 实机验证完成 ===');
