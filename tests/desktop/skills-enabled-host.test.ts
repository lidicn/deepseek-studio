// @vitest-environment node
/**
 * ㊿-c ②：技能开关宿主级（真宿主链）。
 *
 * 与 `skills-enabled-toggle.test.ts`（skill-store 纯函数）互补：这里打**真相源**——
 * 真起 `createDesktopHost`，走真实 `invokeTool`：
 *   1. `skill.list` 每枚带 `enabled`（disabledSkills 派生）；
 *   2. `skill.enabled.set` 落盘（config.json 的 `disabledSkills`，空清单整键删）；
 *   3. 落盘后 `skill.list` 立即反映新态（同一进程内读同一份配置）；
 *   4. 缺参回 missing-argument；未知 id 按集合语义落盘（PM 事后裁定，注释已记）；
 *   5. `skill.enabled.set` 不在模型面（SUPPORTED_INVOCATION_NAMES 不含它）。
 *
 * 配置路径：STUDIO_CONFIG_DIR 驱动（`defaultConfigPath` 的唯一覆盖入口）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopHost } from '../../src/host/desktop-host';

const tmpDirs: string[] = [];
let prevConfigDir: string | undefined;

function mkConfigDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-enabled-host-'));
  tmpDirs.push(d);
  return d;
}

function useConfigDir(dir: string): void {
  prevConfigDir = process.env.STUDIO_CONFIG_DIR;
  process.env.STUDIO_CONFIG_DIR = dir;
}

function restoreEnv(): void {
  if (prevConfigDir === undefined) delete process.env.STUDIO_CONFIG_DIR;
  else process.env.STUDIO_CONFIG_DIR = prevConfigDir;
}

/** 在临时配置目录下造一枚可被 skill.list 扫到的技能（多根扫描第二根 = <configDir>/skills）。 */
function mkSkill(dir: string, id: string, name: string): void {
  const skillDir = path.join(dir, 'skills', id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\ndescription: ${id} 测试技能\n---\n\n# ${name}\n\n正文。\n`,
    'utf8',
  );
}

async function skillList(host: ReturnType<typeof createDesktopHost>): Promise<Array<{ id: string; enabled?: boolean }>> {
  const res = await host.invokeTool('skill.list', {});
  expect(res.ok).toBe(true);
  const data = res.data as { skills: Array<{ id: string; enabled?: boolean }> };
  return data.skills;
}

afterEach(() => {
  restoreEnv();
  // 清理是尽力而为：宿主侧 sqlite / sidecar 可能仍持有句柄（Windows 上 rmSync 会 EPERM），
  // 留在系统 temp 里的临时目录不影响断言正确性（每个用例都用新 mkConfigDir）。
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d as string, { recursive: true, force: true }); } catch { /* 留给 OS temp 清理 */ }
  }
});

describe('㊿-c ② · 真宿主链（skill.list enabled 派生 / skill.enabled.set 落盘）', () => {
  it('缺省全开 → set(false) 落盘 → list 立即反映 → set(true) 回开且整键删除', async () => {
    const dir = mkConfigDir();
    useConfigDir(dir);
    mkSkill(dir, 'skill-x', '技能X');
    mkSkill(dir, 'skill-y', '技能Y');

    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    try {
      // ① 缺省全开且每枚带 enabled
      const before = await skillList(host);
      const x = before.find((s) => s.id === 'skill-x');
      expect(x?.enabled).toBe(true);

      // ② 禁用 skill-x ⇒ 落盘
      const r1 = await host.invokeTool('skill.enabled.set', { id: 'skill-x', enabled: false });
      expect(r1.ok).toBe(true);
      const disk1 = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
        disabledSkills?: string[];
      };
      expect(disk1.disabledSkills).toEqual(['skill-x']);

      // ③ list 立即反映：x 禁用、y 仍开
      const mid = await skillList(host);
      expect(mid.find((s) => s.id === 'skill-x')?.enabled).toBe(false);
      expect(mid.find((s) => s.id === 'skill-y')?.enabled).toBe(true);

      // ④ 回开 ⇒ 空清单整键删除（不留空数组）
      const r2 = await host.invokeTool('skill.enabled.set', { id: 'skill-x', enabled: true });
      expect(r2.ok).toBe(true);
      const diskText = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
      expect(diskText).not.toContain('disabledSkills');

      // ⑤ list 回到全开
      const after = await skillList(host);
      expect(after.find((s) => s.id === 'skill-x')?.enabled).toBe(true);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('缺参回 missing-argument；未知 id 按集合语义落盘（不报 skill-not-found）', async () => {
    const dir = mkConfigDir();
    useConfigDir(dir);
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    try {
      const r1 = await host.invokeTool('skill.enabled.set', { enabled: false });
      expect(r1.ok).toBe(false);
      expect(JSON.stringify(r1)).toContain('missing-argument');
      const r2 = await host.invokeTool('skill.enabled.set', { id: 'skill-x' });
      expect(r2.ok).toBe(false);
      expect(JSON.stringify(r2)).toContain('missing-argument');
      // 未知 id：目录里没有这枚，仍按 id 集合落盘（孤儿 id 与扫描求交为空，无害）
      const r3 = await host.invokeTool('skill.enabled.set', { id: 'ghost-skill', enabled: false });
      expect(r3.ok).toBe(true);
      const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
        disabledSkills?: string[];
      };
      expect(disk.disabledSkills).toEqual(['ghost-skill']);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('skill.enabled.set 不在模型面（SUPPORTED_INVOCATION_NAMES 不含它）', async () => {
    const { SUPPORTED_INVOCATION_NAMES, mapUpstreamToolInvocation } = await import('../../src/shared/tool-contract');
    expect(SUPPORTED_INVOCATION_NAMES).not.toContain('skill.enabled.set');
    // UI 直调仍能映射（经 callHostTool 投递要能到宿主）
    expect(mapUpstreamToolInvocation('skill.enabled.set', { id: 'a', enabled: false })).toEqual({
      id: 'skill.enabled.set',
      params: { id: 'a', enabled: false },
    });
  });

  it('开关变化广播 skills-changed 到已连接页端（真实 hub 通道）', async () => {
    const { WebSocket } = await import('ws');
    const dir = mkConfigDir();
    useConfigDir(dir);
    mkSkill(dir, 'skill-x', '技能X');
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const received: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p-sk' }));
      });
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw)) as { type?: string };
          received.push(m.type ?? '');
          if (m.type === 'hello-ack') resolve();
        } catch { /* ignore */ }
      });
      ws.on('error', reject);
    });
    try {
      const r = await host.invokeTool('skill.enabled.set', { id: 'skill-x', enabled: false });
      expect(r.ok).toBe(true);
      // 有界等待广播到达（hub 转发是同步逐页 send，一轮事件循环内应到）
      await new Promise((res) => setTimeout(res, 200));
      expect(received).toContain('skills-changed');
    } finally {
      ws.close();
      await host.stop();
    }
  }, 60_000);
});
