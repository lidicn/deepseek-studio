/**
 * C1 P0-2 回归测试：用户配置文件的安全边界。
 *
 * 契约（对应 BUG-005 / BUG-004）：
 *   1. **坏配置不覆盖** —— 配置文件损坏时，改名备份 `.bad`，
 *      原文件**字节不变**、本次进程**不写盘**（不得用内存随机 token 覆盖用户文件）；
 *   2. **写盘合并保留既有字段** —— 补 token/secret 触发写盘时，
 *      `chatRooms` / `chatRoomMaxDepth` / `apiEngine` 及其它未知键**一律保留**。
 *
 * 测试用临时目录，**绝不碰用户真实的 ~/.config/deepseek-studio/config.json**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../../src/api/config-loader';

const tmpRoot = path.join(os.tmpdir(), `studio-cfg-p0-2-${Date.now()}`);

function cfgPath(name = 'config.json'): { dir: string; file: string } {
  const dir = path.join(tmpRoot, `c-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, file: path.join(dir, name) };
}

/** 清掉可能影响 loadConfig 的环境变量，保证测试确定性。 */
function withCleanEnv<T>(fn: () => T): T {
  const keys = [
    'DEEPSEEK_STUDIO_TOKEN',
    'DEEPSEEK_STUDIO_SECRET',
    'DEEPSEEK_STUDIO_HOST',
    'DEEPSEEK_STUDIO_PORT',
    'STUDIO_WORKSPACE_ROOT',
    'STUDIO_POLICY_MODE',
    'STUDIO_CHAT_ROOMS_JSON',
    'DEEPSEEK_STUDIO_API_KEY',
  ] as const;
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('C1 P0-2 / BUG-005 + BUG-004：配置文件安全边界', () => {
  it('1. 坏配置：原文件字节不变 + 备份 .bad 保留原始字节 + 本次不写盘', () => {
    const { dir, file } = cfgPath();
    const broken = '{ "token": "abc", this is not json';
    fs.writeFileSync(file, broken, 'utf-8');
    const beforeBytes = fs.readFileSync(file);

    const res = withCleanEnv(() => loadConfig({ cfgDir: dir, cfgPath: file }));

    // 原文件**字节不变**（既没被覆盖、也没被删）。
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file).equals(beforeBytes)).toBe(true);
    // 备份存在且内容相同。
    expect(fs.existsSync(`${file}.bad`)).toBe(true);
    expect(fs.readFileSync(`${file}.bad`, 'utf-8')).toBe(broken);
    // 本次进程标记为「文件损坏 → 禁写盘」。
    expect(res.configFileBroken).toBe(true);
    // 仍然能启动（token 为内存随机值，不落盘）。
    expect(res.config.token.length).toBeGreaterThan(0);
  });

  it('2. 坏配置场景下不会用随机 token 覆盖磁盘', () => {
    const { dir, file } = cfgPath();
    fs.writeFileSync(file, 'not json at all', 'utf-8');
    const before = fs.readFileSync(file, 'utf-8');

    withCleanEnv(() => loadConfig({ cfgDir: dir, cfgPath: file }));

    // 文件内容仍是坏内容 —— 没有被「合法配置」覆盖。
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('3. 写盘合并：chatRooms / chatRoomMaxDepth / apiEngine 与未知键全部保留', () => {
    const { dir, file } = cfgPath();
    // 一份「缺 token/secret」但带全部用户配置的 config.json。
    const original = {
      host: '127.0.0.1',
      port: 8760,
      chatRooms: [
        { roomId: 'r1', roomName: '我的聊天室', memberPersonas: ['p1', 'p2'] },
      ],
      chatRoomMaxDepth: 3,
      apiEngine: { baseURL: 'https://api.deepseek.com', apiKey: 'sk-real-key', model: 'deepseek-chat' },
      未来新增字段: { keep: true },
    };
    fs.writeFileSync(file, JSON.stringify(original, null, 2), 'utf-8');

    withCleanEnv(() => loadConfig({ cfgDir: dir, cfgPath: file }));

    const after = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    // 用户配置**没丢**。
    expect(after.chatRooms).toEqual(original.chatRooms);
    expect(after.chatRoomMaxDepth).toBe(3);
    expect(after.apiEngine).toEqual(original.apiEngine);
    // 未知键也保留（写盘是「合并」不是「重建」）。
    expect(after['未来新增字段']).toEqual({ keep: true });
    // 本次补上的 token/secret 也在。
    expect(typeof after.token).toBe('string');
    expect((after.token as string).length).toBeGreaterThan(0);
    expect(typeof after.secret).toBe('string');
  });

  it('4. 已有 token/secret 时不写盘（不产生无谓改动）', () => {
    const { dir, file } = cfgPath();
    const original = { token: 'tok-keep', secret: 'sec-keep', host: '127.0.0.1', port: 8760 };
    const raw = JSON.stringify(original, null, 2);
    fs.writeFileSync(file, raw, 'utf-8');

    withCleanEnv(() => loadConfig({ cfgDir: dir, cfgPath: file }));

    expect(fs.readFileSync(file, 'utf-8')).toBe(raw);
  });

  it('5. 首次运行（文件不存在）正常生成配置', () => {
    const { dir, file } = cfgPath();
    const res = withCleanEnv(() => loadConfig({ cfgDir: dir, cfgPath: file }));

    expect(res.configFileBroken).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(typeof written.token).toBe('string');
    expect(typeof written.secret).toBe('string');
  });
});
