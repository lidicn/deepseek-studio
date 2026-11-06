/**
 * tests/desktop/config-migration.test.ts
 *
 * 批 N+1 段 3 首启迁移的回归用例（设计稿 §8.5）。
 *
 * **红线**：全部用例只碰 `mkdtemp` 临时目录 —— 真实 `~/.config/deepseek-studio`
 * 现在是用户装版实例的活数据（config.json / memories.db / memories.db.audit.key）。
 * 迁移逻辑一旦在真目录上被"试跑"，就是搬走用户数据、不可逆。
 *
 * 覆盖 PM 裁定③ 的四条硬要求：(a) 幂等不覆盖 (b) 源保留不删 (c) migration.log 可对账
 * (d) memories.db 与 .audit.key 成对、缺件显式记 WARN。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  migrateLegacyConfig,
  runStartupMigration,
  GENERATION,
  MIGRATION_LOG_NAME,
} from '../../src/host/config-migration';
import { resolveStudioDataDir } from '../../src/shared/distribution';
import { McpController, loadMcpServers, removeMcpServer } from '../../src/host/mcp-controller';

let root: string;
let legacy: string;
let next: string;

function mk(base: string, rel: string, content: string): string {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-migrate-'));
  legacy = path.join(root, 'legacy-config');
  next = path.join(root, 'data', 'config');
  fs.mkdirSync(legacy, { recursive: true });
  // 新目录由 Rust 侧先建出来（迁移的前置条件）
  fs.mkdirSync(next, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveStudioDataDir：只做字符串推导，不猜位置', () => {
  it('两个 env 同父 → 返回父目录', () => {
    expect(
      resolveStudioDataDir({
        STUDIO_CONFIG_DIR: path.join('X:', 'data', 'config'),
        STUDIO_LOG_DIR: path.join('X:', 'data', 'logs'),
      } as NodeJS.ProcessEnv),
    ).toBe(path.join('X:', 'data'));
  });

  it('缺一个 / 父目录不一致 / 两个同值 → null（宁可这次不迁移，也不搬错地方）', () => {
    expect(
      resolveStudioDataDir({ STUDIO_CONFIG_DIR: path.join('X:', 'data', 'config') } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      resolveStudioDataDir({
        STUDIO_CONFIG_DIR: path.join('X:', 'a', 'config'),
        STUDIO_LOG_DIR: path.join('Y:', 'b', 'logs'),
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      resolveStudioDataDir({
        STUDIO_CONFIG_DIR: path.join('X:', 'data'),
        STUDIO_LOG_DIR: path.join('X:', 'data'),
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe('触发条件：不该迁移的情形一律不动', () => {
  it('新目录不存在 → new-dir-missing（不凭一个 env 就凭空造目录）', () => {
    const r = migrateLegacyConfig({
      legacyConfigDir: legacy,
      newConfigDir: path.join(root, 'not-there'),
    });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('new-dir-missing');
  });

  it('源与目标同一路径 → same-dir', () => {
    const r = migrateLegacyConfig({ legacyConfigDir: next, newConfigDir: next });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('same-dir');
  });

  it('dev 形态（无注入 env）→ runStartupMigration 直接返回 null', () => {
    expect(runStartupMigration({ STUDIO_DISTRIBUTION: 'dev' } as NodeJS.ProcessEnv, root)).toBeNull();
    expect(runStartupMigration({} as NodeJS.ProcessEnv, root)).toBeNull();
  });
});

describe('全量迁移：4 组数据 + 日志目录 + 窗口状态', () => {
  it('config/mcp/memories(db+key)/shadow/logs/window-state 全搬，源保留不删', () => {
    mk(legacy, 'config.json', '{"token":"KEEP-ME"}');
    mk(legacy, 'mcp-servers.json', '{"servers":{}}');
    mk(legacy, 'memories.db', 'SQLITE-BYTES');
    mk(legacy, 'memories.db.audit.key', 'a'.repeat(64));
    mk(legacy, 'shadow/index.json', '{"entries":[]}');
    mk(legacy, 'shadow/sh_1.bin', 'shadowed');
    const legacyLogs = path.join(root, 'roaming', 'logs');
    mk(legacyLogs, 'sidecar-1.log', 'old log line');
    const legacyData = path.join(root, 'roaming');
    mk(legacyData, 'window-state.json', '{"width":800}');
    const newLogs = path.join(root, 'data', 'logs');
    fs.mkdirSync(newLogs, { recursive: true });

    const r = migrateLegacyConfig({
      legacyConfigDir: legacy,
      newConfigDir: next,
      legacyLogDir: legacyLogs,
      newLogDir: newLogs,
      legacyDataDir: legacyData,
    });

    expect(r.ran).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);

    // 目标侧逐个到位
    for (const rel of [
      'config.json',
      'mcp-servers.json',
      'memories.db',
      'memories.db.audit.key',
      'shadow/index.json',
      'shadow/sh_1.bin',
      'window-state.json',
    ]) {
      expect(fs.existsSync(path.join(next, rel)), `${rel} 应已迁移`).toBe(true);
    }
    expect(fs.readFileSync(path.join(next, 'config.json'), 'utf8')).toBe('{"token":"KEEP-ME"}');
    expect(fs.existsSync(path.join(newLogs, 'sidecar-1.log'))).toBe(true);

    // **源保留不删**（§8.5 判据 3）：迁移不是搬家，老目录一字不动
    for (const rel of ['config.json', 'memories.db', 'memories.db.audit.key']) {
      expect(fs.existsSync(path.join(legacy, rel)), `${rel} 源必须保留`).toBe(true);
    }
    expect(fs.existsSync(path.join(legacyLogs, 'sidecar-1.log'))).toBe(true);
    expect(fs.existsSync(path.join(legacyData, 'window-state.json'))).toBe(true);

    // migration.log 可对账：代际 + 逐项 sha256 + 结果
    const log = fs.readFileSync(path.join(next, MIGRATION_LOG_NAME), 'utf8');
    expect(log).toContain(`generation=${GENERATION}`);
    expect(log).toMatch(/copied config\.json \| .* -> .* \| bytes=\d+ sha256_12=[0-9a-f]{12}/);
    expect(log).toContain('warnings=0');
    expect(log).toContain('errors=0');
  });

  it('幂等：第二次跑直接跳过（不重复搬、不覆盖）', () => {
    mk(legacy, 'config.json', '{"a":1}');
    const first = migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    expect(first.ran).toBe(true);

    const second = migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('already-migrated');
    expect(second.copied).toEqual([]);
  });

  it('目标已存在 → 不覆盖（跳过并记 skip-existing）', () => {
    mk(legacy, 'config.json', '{"from":"legacy"}');
    mk(next, 'config.json', '{"from":"new"}');

    const r = migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    expect(r.copied).not.toContain('config.json');
    expect(r.skippedExisting).toContain('config.json');
    // 新数据一字不动（判错代价不对称：覆盖 = 丢用户新配置，不可逆）
    expect(fs.readFileSync(path.join(next, 'config.json'), 'utf8')).toBe('{"from":"new"}');
  });
});

describe('memories.db 与 memories.db.audit.key 成对（PM 硬要求 d）', () => {
  it('有 db 无 key → 搬 db 并显式 WARN（不许静默）', () => {
    mk(legacy, 'memories.db', 'SQLITE');
    const r = migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    expect(r.copied).toContain('memories.db');
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join('\n')).toContain('审计密钥');
    const log = fs.readFileSync(path.join(next, MIGRATION_LOG_NAME), 'utf8');
    expect(log).toContain('warn ');
  });

  it('有 key 无 db → 搬 key 并显式 WARN', () => {
    mk(legacy, 'memories.db.audit.key', 'k'.repeat(64));
    const r = migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    expect(r.copied).toContain('memories.db.audit.key');
    expect(r.warnings.join('\n')).toContain('缺失');
  });

  it('两个都在 → 成对搬到新目录（缺一即红）', () => {
    mk(legacy, 'memories.db', 'SQLITE');
    mk(legacy, 'memories.db.audit.key', 'k'.repeat(64));
    const r = migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    expect(r.warnings).toEqual([]);
    expect(fs.existsSync(path.join(next, 'memories.db'))).toBe(true);
    expect(fs.existsSync(path.join(next, 'memories.db.audit.key'))).toBe(true);
  });

  it('db 已在、key 缺 → 仍补搬 key（补件不覆盖）', () => {
    mk(next, 'memories.db', 'NEW-DB');
    mk(legacy, 'memories.db', 'OLD-DB');
    mk(legacy, 'memories.db.audit.key', 'k'.repeat(64));

    const r = migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    // db 被跳过（不覆盖新库），key 补上 —— 老库解不开时新库仍可解
    expect(r.skippedExisting).toContain('memories.db');
    expect(r.copied).toContain('memories.db.audit.key');
    expect(fs.readFileSync(path.join(next, 'memories.db'), 'utf8')).toBe('NEW-DB');
    expect(fs.existsSync(path.join(next, 'memories.db.audit.key'))).toBe(true);
  });
});

describe('window-state.json（PM 裁定③：搬，目标不存在才拷）', () => {
  it('老 rside 根有、新目录无 → 搬（用户窗口几何不丢）', () => {
    const legacyData = path.join(root, 'roaming');
    mk(legacyData, 'window-state.json', '{"width":1024,"height":768}');
    const r = migrateLegacyConfig({
      legacyConfigDir: legacy,
      newConfigDir: next,
      legacyDataDir: legacyData,
    });
    expect(fs.existsSync(path.join(next, 'window-state.json'))).toBe(true);
    expect(r.details.map((d) => d.rel)).toContain('window-state.json');
    // 源保留
    expect(fs.existsSync(path.join(legacyData, 'window-state.json'))).toBe(true);
  });

  it('新目录已有 → 不覆盖', () => {
    mk(next, 'window-state.json', '{"width":640}');
    const legacyData = path.join(root, 'roaming');
    mk(legacyData, 'window-state.json', '{"width":1024}');
    migrateLegacyConfig({
      legacyConfigDir: legacy,
      newConfigDir: next,
      legacyDataDir: legacyData,
    });
    expect(fs.readFileSync(path.join(next, 'window-state.json'), 'utf8')).toBe('{"width":640}');
  });

  it('不传 legacyDataDir（dev / 未注入）→ 不搬窗口状态', () => {
    const legacyData = path.join(root, 'roaming');
    mk(legacyData, 'window-state.json', '{"width":1024}');
    migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    expect(fs.existsSync(path.join(next, 'window-state.json'))).toBe(false);
  });
});

describe('裁定十四：迁移后的「第一次写入」不丢面板外条目', () => {
  it('list 读文件全量；saveServer 读-改-写 → 面板未加载到的条目保存后仍在', () => {
    // 合成夹具：迁移前老目录里有两台（含一台面板「不认识」的），迁移后新目录也含它们
    mk(legacy, 'mcp-servers.json', JSON.stringify({
      servers: {
        legacyOnly: { command: 'npx', args: ['-y', 'legacy-tool'] },
        shared: { command: 'node', args: ['shared.js'] },
      },
    }));
    const r = migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    expect(r.copied).toContain('mcp-servers.json');

    // list 路径读**文件全量**（不是只读面板已知的那几枚）
    const listed = loadMcpServers(path.join(next, 'mcp-servers.json'));
    expect(Object.keys(listed).sort()).toEqual(['legacyOnly', 'shared']);

    // 用户在面板里只编辑/新增一台 → 其余条目必须原样保留
    const ctl = new McpController(path.join(next, 'mcp-servers.json'));
    const saved = ctl.saveServer('panelNew', { command: 'node', args: ['panel.js'] } as never);
    expect(saved.ok).toBe(true);

    const after = loadMcpServers(path.join(next, 'mcp-servers.json'));
    expect(Object.keys(after).sort()).toEqual(['legacyOnly', 'panelNew', 'shared']);
    // 迁移来的条目内容也不能被改写
    expect(after.legacyOnly).toEqual({ command: 'npx', args: ['-y', 'legacy-tool'] });
  });

  it('面板删除一台时，其余迁移来的条目不受影响（反向：删除不是整表重建）', () => {
    mk(legacy, 'mcp-servers.json', JSON.stringify({
      servers: { keepMe: { command: 'node', args: ['keep.js'] }, dropMe: { command: 'node', args: ['drop.js'] } },
    }));
    migrateLegacyConfig({ legacyConfigDir: legacy, newConfigDir: next });
    const p = path.join(next, 'mcp-servers.json');

    expect(removeMcpServer('dropMe', p).ok).toBe(true);
    expect(Object.keys(loadMcpServers(p)).sort()).toEqual(['keepMe']);
    expect(loadMcpServers(p).keepMe).toEqual({ command: 'node', args: ['keep.js'] });
  });
});

describe('runStartupMigration：装版形态下的完整路径推导', () => {
  it('装版 + 两个 env → 跑迁移，日志落在新配置目录', () => {
    const home = path.join(root, 'home');
    const legacyCfg = path.join(home, '.config', 'deepseek-studio');
    mk(legacyCfg, 'config.json', '{"token":"OLD"}');
    const data = path.join(root, 'appdata', 'deepseek-studio');
    const newCfg = path.join(data, 'config');
    fs.mkdirSync(newCfg, { recursive: true });

    const r = runStartupMigration(
      {
        STUDIO_DISTRIBUTION: 'installed',
        STUDIO_CONFIG_DIR: newCfg,
        STUDIO_LOG_DIR: path.join(data, 'logs'),
      } as NodeJS.ProcessEnv,
      home,
    );
    expect(r?.ran).toBe(true);
    expect(fs.readFileSync(path.join(newCfg, 'config.json'), 'utf8')).toBe('{"token":"OLD"}');
    expect(r?.logPath).toBe(path.join(newCfg, MIGRATION_LOG_NAME));
  });

  it('装版但缺一个 env（Rust 没注入全）→ 不迁移、不报错', () => {
    const home = path.join(root, 'home');
    const r = runStartupMigration(
      {
        STUDIO_DISTRIBUTION: 'installed',
        STUDIO_CONFIG_DIR: path.join(root, 'data', 'config'),
      } as NodeJS.ProcessEnv,
      home,
    );
    expect(r).toBeNull();
  });
});
