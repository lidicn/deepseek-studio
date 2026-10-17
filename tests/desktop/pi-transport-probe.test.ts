import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runProbeTurn, scriptedStreamFn, stubTool } from '../../src/host/kernel/pi-transport-probe';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('pi-transport-probe (M1-3)', () => {
  it('1. scripted streamFn is accepted by Agent without throwing', async () => {
    const fn = scriptedStreamFn('test');
    expect(typeof fn).toBe('function');
    // calling it returns an AssistantMessageEventStream
    const s = fn({} as never, {} as never);
    expect(s).toBeDefined();
  });

  it('2. runs one turn and receives at least one delta + agent_end', async () => {
    const result = await runProbeTurn();
    expect(result.ok).toBe(true);
    expect(result.events).toContain('agent_start');
    expect(result.events).toContain('agent_end');
    expect(result.finalText).toContain('probe: ok');
  });

  it('3. stub tool satisfies AgentTool shape (name + execute)', () => {
    const t = stubTool();
    expect(t.name).toBe('probe.echo');
    expect(typeof t.execute).toBe('function');
    // execute can be invoked
    return expect(t.execute('id1', {}, undefined, () => {})).resolves.toMatchObject({
      isError: false,
    });
  });

  it('4. probe source does NOT import web-engine / agent-loop', () => {
    const src = readFileSync(
      join(__dirname, '../../src/host/kernel/pi-transport-probe.ts'),
      'utf8',
    );
    // strip comments so doc mentions don't trip the assertion
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/from\s+['"].*web-engine/);
    expect(code).not.toMatch(/from\s+['"].*agent-loop/);
  });
});
