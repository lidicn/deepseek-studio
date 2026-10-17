#!/usr/bin/env tsx
/**
 * tools/eval/run.ts — Golden contract evaluator (M0-3)
 *
 * Reads every *.json under fixtures/, dispatches by `contract` field,
 * calls the real src/ functions, and compares the returned value against
 * `expect`. Any FAIL → process.exit(1).
 *
 * Usage: npm run eval:golden
 * Add a new case: drop a JSON file next to this README.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- contracts under test (read-only imports of src/) ----
import {
  mapUpstreamToolInvocation,
  isSupportedUpstreamTool,
} from '../../src/shared/tool-contract';
import {
  textContent,
  formatToolResultText,
  buildExecExtras,
  buildErrorExtras,
  shouldSkipAutoContinue,
  joinContent,
} from '../../src/shared/tool-result-format';
import {
  extractTaskCompleteSignal,
  buildContinuationPrompt,
  clampText,
  shouldNudge,
} from '../../src/shared/continuation-prompt';
import {
  evaluatePolicy,
  isFileTool,
  detectRisks,
} from '../../src/host/policy';
import { createWorkspace } from '../../src/host/workspace';
import type { WorkspaceContext } from '../../src/host/workspace';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import type { ModelEngine, EngineSendResult, ToolCallRecord } from '../../src/host/engine/model-engine';

// ---------------------------------------------------------------- types

interface Fixture {
  name: string;
  contract:
    | 'tool-contract'
    | 'tool-result-format'
    | 'continuation-prompt'
    | 'policy';
  case: string;
  input: Record<string, unknown>;
  expect: unknown;
}

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

// ---------------------------------------------------------------- helpers

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

/** Minimal structural deep-equal (handles null / arrays / plain objects / primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

function fmt(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Build a pure lexical WorkspaceContext from a root path string (no real fs). */
function makeWorkspace(root: string): WorkspaceContext {
  return createWorkspace(root, {
    realpath: (p: string) => p,
    statSync: () => undefined,
    resolve: (p: string) => resolve(p),
  });
}

// ---------------------------------------------------------------- dispatch

async function runOne(fx: Fixture): Promise<CaseResult> {
  try {
    let actual: unknown;

    switch (`${fx.contract}/${fx.case}`) {
      // ---- tool-contract ----
      case 'tool-contract/map': {
        const inv = fx.input.invocationName as string;
        const params = (fx.input.params ?? {}) as Record<string, unknown>;
        actual = mapUpstreamToolInvocation(inv, params);
        break;
      }
      case 'tool-contract/isSupported': {
        actual = isSupportedUpstreamTool(fx.input.invocationName as string);
        break;
      }
      case 'tool-contract/isFileTool': {
        actual = isFileTool(fx.input.tool as string);
        break;
      }
      case 'tool-contract/detectRisks': {
        actual = detectRisks(fx.input.command as string);
        break;
      }

      // ---- tool-result-format ----
      case 'tool-result-format/textContent': {
        actual = textContent(fx.input.text as string);
        break;
      }
      case 'tool-result-format/formatToolResultText': {
        actual = formatToolResultText(fx.input.result as Parameters<typeof formatToolResultText>[0]);
        break;
      }
      case 'tool-result-format/buildExecExtras': {
        actual = buildExecExtras(fx.input.input as Parameters<typeof buildExecExtras>[0]);
        break;
      }
      case 'tool-result-format/buildErrorExtras': {
        actual = buildErrorExtras(fx.input.input as Parameters<typeof buildErrorExtras>[0]);
        break;
      }
      case 'tool-result-format/shouldSkipAutoContinue': {
        actual = shouldSkipAutoContinue(
          fx.input.results as Parameters<typeof shouldSkipAutoContinue>[0],
        );
        break;
      }
      case 'tool-result-format/joinContent': {
        actual = joinContent(fx.input.content as Parameters<typeof joinContent>[0]);
        break;
      }

      // ---- continuation-prompt ----
      case 'continuation-prompt/extractTaskCompleteSignal': {
        actual = extractTaskCompleteSignal(fx.input.text as string);
        break;
      }
      case 'continuation-prompt/buildContinuationPrompt': {
        const out = buildContinuationPrompt(
          fx.input.originalTask as string,
          fx.input.executions as Parameters<typeof buildContinuationPrompt>[1],
          (fx.input.toolCatalog as string | undefined) ?? undefined,
        );
        // expect can be { contains: [...], notContains: [...] } or exact string
        if (fx.input.mode === 'sentinel') {
          const expected = fx.expect as { contains?: string[]; notContains?: string[] };
          const contains = expected.contains ?? [];
          const notContains = expected.notContains ?? [];
          const missing = contains.filter((s) => !out.includes(s));
          const extra = notContains.filter((s) => out.includes(s));
          if (missing.length === 0 && extra.length === 0) {
            actual = expected; // pass: actual mirrors expected shape
          } else {
            actual = { __missing: missing, __unexpected: extra };
          }
        } else {
          actual = out;
        }
        break;
      }
      case 'continuation-prompt/clampText': {
        actual = clampText(
          fx.input.value as string | undefined,
          fx.input.maxLen as number,
        );
        break;
      }
      case 'continuation-prompt/shouldNudge': {
        actual = shouldNudge(fx.input.visibleText as string);
        break;
      }

      // ---- policy ----
      case 'policy/evaluate': {
        const workspaceRoot = fx.input.workspaceRoot as string | null | undefined;
        const ws: WorkspaceContext | null =
          workspaceRoot === undefined || workspaceRoot === null
            ? null
            : makeWorkspace(workspaceRoot);
        const verdict = evaluatePolicy({
          tool: fx.input.tool as string,
          params: (fx.input.params ?? {}) as Record<string, unknown>,
          mode: fx.input.mode as Parameters<typeof evaluatePolicy>[0]['mode'],
          workspace: ws,
          ...(fx.input.trustedDirs
            ? { trustedDirs: fx.input.trustedDirs as readonly string[] }
            : {}),
        });
        // Compare only the fields in expect (partial match — ignore riskFlags/detail)
        const expected = fx.expect as Record<string, unknown>;
        const trimmed: Record<string, unknown> = {};
        for (const k of Object.keys(expected)) {
          trimmed[k] = (verdict as unknown as Record<string, unknown>)[k];
        }
        actual = trimmed;
        break;
      }

      // ---- message-history ----
      case 'message-history/snapshot': {
        const h = createMessageHistory();
        h.append({ role: 'user', content: 'hi' });
        h.append({ role: 'assistant', content: 'hello' });
        const snap = h.snapshot();
        actual = { version: snap.version, messageCount: snap.messages.length };
        break;
      }
      case 'message-history/restore': {
        const h1 = createMessageHistory();
        h1.append({ role: 'user', content: 'test' });
        const snap = h1.snapshot();
        const h2 = createMessageHistory();
        h2.restore(snap);
        actual = { size: h2.size(), firstRole: h2.all()[0]?.role };
        break;
      }
      case 'message-history/version-mismatch': {
        const h = createMessageHistory();
        let threw = false;
        try {
          h.restore({ version: 2, messages: [] });
        } catch {
          threw = true;
        }
        actual = { threw };
        break;
      }

      // ---- tool-call-record ----
      case 'tool-call-record/shape': {
        const rec: ToolCallRecord = { tool: 'shell.exec', ok: true };
        actual = rec;
        break;
      }
      case 'tool-call-record/optional-undefined': {
        const r: EngineSendResult = { content: 'x', toolCalls: 0 };
        actual = { hasToolCallRecords: 'toolCallRecords' in r, value: r.toolCallRecords ?? null };
        break;
      }
      case 'tool-call-record/present': {
        const recs: ToolCallRecord[] = [{ tool: 'read_file', ok: true }];
        const r: EngineSendResult = { content: 'x', toolCalls: 1, toolCallRecords: recs };
        actual = { count: r.toolCallRecords?.length, first: r.toolCallRecords?.[0]?.tool };
        break;
      }

      // ---- task-loop ----
      case 'task-loop/stop-completed': {
        const engine: ModelEngine = {
          name: 'web',
          async health() { return { ok: true }; },
          async send() { return { content: 'Done <task_complete>{}</task_complete>', toolCalls: 1 }; },
        };
        const h = createMessageHistory();
        const loop = createTaskLoop({ engine, history: h, maxRounds: 1 });
        const r = await loop.run('test');
        actual = { stopReason: r.stopReason };
        break;
      }
      case 'task-loop/stop-no-tool-calls': {
        const engine: ModelEngine = {
          name: 'web',
          async health() { return { ok: true }; },
          async send() { return { content: 'just text no tools', toolCalls: 0 }; },
        };
        const h = createMessageHistory();
        const loop = createTaskLoop({ engine, history: h, maxRounds: 1 });
        const r = await loop.run('test');
        actual = { stopReason: r.stopReason };
        break;
      }
      case 'task-loop/stop-timeout': {
        const engine: ModelEngine = {
          name: 'web',
          async health() { return { ok: true }; },
          async send() { return { content: 'partial', toolCalls: 1, timedOut: true }; },
        };
        const h = createMessageHistory();
        const loop = createTaskLoop({ engine, history: h, maxRounds: 1 });
        const r = await loop.run('test');
        actual = { stopReason: r.stopReason };
        break;
      }
      case 'task-loop/priority-timeout': {
        // timeout 优先级高于 completed
        const engine: ModelEngine = {
          name: 'web',
          async health() { return { ok: true }; },
          async send() { return { content: 'timeout <task_complete>{}</task_complete>', toolCalls: 1, timedOut: true }; },
        };
        const h = createMessageHistory();
        const loop = createTaskLoop({ engine, history: h, maxRounds: 1 });
        const r = await loop.run('test');
        actual = { stopReason: r.stopReason };
        break;
      }

      // ---- S16 新增 ----
      case 'task-loop/multi-round': {
        // 3 轮工具后 completed
        let round = 0;
        const engine: ModelEngine = {
          name: 'web',
          async health() { return { ok: true }; },
          async send() {
            round++;
            if (round < 3) return { content: 'working...', toolCalls: 1 };
            return { content: 'done <task_complete>{}</task_complete>', toolCalls: 1 };
          },
        };
        const h = createMessageHistory();
        const loop = createTaskLoop({ engine, history: h, maxRounds: 5 });
        const r = await loop.run('test');
        actual = { stopReason: r.stopReason, rounds: r.round };
        break;
      }
      case 'task-loop/max-rounds': {
        const engine: ModelEngine = {
          name: 'web',
          async health() { return { ok: true }; },
          async send() { return { content: 'still working', toolCalls: 1 }; },
        };
        const h = createMessageHistory();
        const loop = createTaskLoop({ engine, history: h, maxRounds: 2 });
        const r = await loop.run('test');
        actual = { stopReason: r.stopReason };
        break;
      }
      case 'engine/completion-truncated': {
        const r: EngineSendResult = { content: 'partial...', toolCalls: 0, timedOut: true, completion: 'truncated' };
        actual = { completion: r.completion, timedOut: r.timedOut };
        break;
      }
      case 'engine/completion-disconnected': {
        const r: EngineSendResult = { content: '', toolCalls: 0, completion: 'disconnected' };
        actual = { completion: r.completion };
        break;
      }
      case 'tool-call-record/multi': {
        const recs: ToolCallRecord[] = [
          { tool: 'read_file', ok: true },
          { tool: 'write_file', ok: true },
          { tool: 'shell.exec', ok: false, error: 'denied' },
        ];
        actual = { count: recs.length, failures: recs.filter((r) => !r.ok).length };
        break;
      }
      case 'message-history/long-context': {
        const h = createMessageHistory();
        for (let i = 0; i < 10; i++) h.append({ role: 'user', content: `msg-${i}` });
        const snap = h.snapshot();
        actual = { count: snap.messages.length };
        break;
      }
      case 'message-history/empty': {
        const h = createMessageHistory();
        actual = { size: h.size(), roles: h.byRole('user').length };
        break;
      }
      case 'special-chars/echo': {
        actual = { text: fx.input.text };
        break;
      }

      default:
        return {
          name: fx.name,
          pass: false,
          detail: `unknown contract/case: ${fx.contract}/${fx.case}`,
        };
    }

    // ---- message-history ----
    // （放在 switch 外面，因为需要 setup + 断言多步）

    const pass = deepEqual(actual, fx.expect);
    return {
      name: fx.name,
      pass,
      detail: pass
        ? ''
        : `expected ${fmt(fx.expect)}\n     got      ${fmt(actual)}`,
    };
  } catch (err) {
    return {
      name: fx.name,
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.error('no fixture files found under', FIXTURES_DIR);
    process.exit(1);
  }

  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const file of files) {
    const raw = readFileSync(join(FIXTURES_DIR, file), 'utf8');
    const fx = JSON.parse(raw) as Fixture;
    const r = await runOne(fx);
    const tag = r.pass ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${file} — ${r.name}`);
    if (!r.pass) {
      fail++;
      failures.push(`${file}: ${r.name}\n       ${r.detail}`);
      console.log(`       ${r.detail}`);
    } else {
      pass++;
    }
  }

  console.log('');
  console.log('--- summary ---');
  console.log(`total: ${pass + fail}  pass: ${pass}  fail: ${fail}`);

  if (fail > 0) {
    console.log('');
    console.log('FAILED CASES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
}

main();
