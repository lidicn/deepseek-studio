/**
 * D1 取数工具测试：buildReport() 覆盖 healthy/unhealthy/边界场景。
 */

import { describe, it, expect } from 'vitest';
import { buildReport } from '../../tools/metrics/report';
import { createHarnessMetrics } from '../../src/shared/harness-metrics';
import { createToolEventBus } from '../../src/shared/tool-event-bus';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', '..', 'tools', 'metrics', 'samples');

function readSample(name: string): string[] {
  return readFileSync(join(SAMPLES, name), 'utf8').split('\n');
}

describe('D1 metrics report', () => {
  it('1. healthy 样本 → d1Verdict=PASS, nudgeRate<5%', () => {
    const r = buildReport(readSample('healthy.jsonl'));
    expect(r.d1Verdict).toBe('PASS');
    expect(r.nudgeRate).toBeLessThan(0.05);
    expect(r.toolRounds).toBe(20);
    expect(r.nudgeRounds).toBe(0);
  });

  it('2. unhealthy 样本 → d1Verdict=FAIL, nudgeRate>=5%', () => {
    const r = buildReport(readSample('unhealthy.jsonl'));
    expect(r.d1Verdict).toBe('FAIL');
    expect(r.nudgeRate).toBeGreaterThanOrEqual(0.05);
    expect(r.toolRounds).toBe(20);
    expect(r.nudgeRounds).toBe(3);
  });

  it('3. 空文件 → totalLines=0', () => {
    const r = buildReport(['', '', '']);
    expect(r.totalLines).toBe(0);
    expect(r.toolRounds).toBe(0);
  });

  it('4. 全是非法 JSON → parseErrors 等于有效行数，不崩', () => {
    const r = buildReport(['not json', '{oops', '☃️']);
    expect(r.parseErrors).toBe(3);
    expect(r.toolRounds).toBe(0);
  });

  it('5. 含非法 JSON 行 → 跳过该行、计入 parseErrors、其余正常', () => {
    const lines = [
      '{"kind":"loop","type":"tool"}',
      'garbage line',
      '{"kind":"loop","type":"assistant"}',
      '{"kind":"loop","type":"tool"}',
      '{"kind":"loop","type":"assistant"}',
    ];
    const r = buildReport(lines);
    expect(r.parseErrors).toBe(1);
    expect(r.toolRounds).toBe(2);
    expect(r.totalLines).toBe(5);
  });

  it('6. toolRounds < 20 → sampleWarn=true', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push('{"kind":"loop","type":"tool"}');
      lines.push('{"kind":"loop","type":"assistant"}');
    }
    const r = buildReport(lines);
    expect(r.toolRounds).toBe(5);
    expect(r.sampleWarn).toBe(true);
  });

  it('7. nudgeRate 与 createHarnessMetrics() 直接计算完全一致', () => {
    // 同一批事件，两条路径：buildReport vs 直接喂 harness
    const lines = readSample('unhealthy.jsonl');

    const r = buildReport(lines);

    // 路径 B：直接用 harness
    const bus = createToolEventBus();
    const harness = createHarnessMetrics(bus);
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      const obj = JSON.parse(t) as { kind: string; event?: string; type?: string; text?: string };
      if (obj.kind === 'bus' && obj.event) {
        bus.emit(obj.event as 'after-call', { toolName: 'x', params: {} });
      } else if (obj.kind === 'loop') {
        harness.onEvent(obj as never);
      }
    }
    const snap = harness.snapshot();
    harness.dispose();

    expect(r.nudgeRate).toBe(snap.nudgeRate);
    expect(r.toolRounds).toBe(snap.toolRounds);
    expect(r.nudgeRounds).toBe(snap.nudgeRounds);
    expect(r.toolCallsTotal).toBe(snap.toolCallsTotal);
  });

  it('8. 百分比格式化为 2 位小数（nudgeRate 字段精确到小数点后两位）', () => {
    const lines: string[] = [];
    // 20 rounds, 1 nudge = 5.00%
    for (let i = 0; i < 20; i++) {
      lines.push('{"kind":"loop","type":"tool"}');
      if (i === 0) {
        lines.push('{"kind":"loop","type":"status","text":"检测到未解析的工具调用，发送格式纠偏（第 1 次）…"}');
      }
      lines.push('{"kind":"loop","type":"assistant"}');
    }
    const r = buildReport(lines);
    const pct = (r.nudgeRate * 100).toFixed(2);
    expect(pct).toBe('5.00');
    // 边界：5% 正好是 FAIL
    expect(r.d1Verdict).toBe('FAIL');
  });
});
